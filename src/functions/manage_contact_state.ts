import { Context as ServerlessContext, ServerlessCallback } from '@twilio-labs/serverless-runtime-types/types';
import { ContactCadenceState } from '../types/cadence_state';

// Define a custom context type that includes the TWILIO_SYNC_SERVICE_SID
interface MyContext extends ServerlessContext {
  TWILIO_SYNC_SERVICE_SID: string;
  ACTIVE_CADENCE_CONTACTS_LIST_NAME?: string; // Optional: make list name configurable
}

const ACTIVE_CADENCE_CONTACTS_LIST_UNIQUE_NAME = 'active_cadence_contacts';
const SYNC_DOCUMENT_DEFAULT_TTL = 0; // 0 means no TTL, lives forever. Or use e.g. 30 * 24 * 60 * 60 for 30 days

// Helper function to get the Sync client
const getSyncClient = (context: MyContext) => context.getTwilioClient().sync.services(context.TWILIO_SYNC_SERVICE_SID);

// Define a type for the event payload
type ManageContactStateEvent =
  | { action: 'get'; phoneNumber: string }
  | { action: 'addOrUpdate'; state: ContactCadenceState }
  | { action: 'queryDue'; timestamp: string };

// Main handler function
export const handler = async (
  context: MyContext,
  event: ManageContactStateEvent,
  callback: ServerlessCallback
) => {
  console.log('Received event:', event);
  const response = new Twilio.Response(); // For setting headers if needed, or custom status codes

  try {
    switch (event.action) {
      case 'get':
        const state = await getContactState(context, event.phoneNumber);
        if (state) {
          return callback(null, state);
        } else {
          // @ts-ignore
          response.setStatusCode(404);
          return callback(null, { success: false, message: 'Contact not found' });
        }
      case 'addOrUpdate':
        const result = await addOrUpdateContact(context, event.state);
        return callback(null, result);
      case 'queryDue':
        const dueContacts = await queryContactsDueForCall(context, event.timestamp);
        return callback(null, dueContacts);
      default:
        console.error('Unknown action:', (event as any).action);
        // @ts-ignore
        response.setStatusCode(400);
        return callback('Unknown action', null);
    }
  } catch (error) {
    console.error('Error in manage_contact_state handler:', error);
    // @ts-ignore
    response.setStatusCode(500);
    // @ts-ignore
    return callback(error.message || 'Internal server error', null);
  }
};

// Internal function to add or update contact state
async function addOrUpdateContact(
  context: MyContext,
  state: ContactCadenceState
): Promise<{ success: boolean; message?: string }> {
  console.log(`addOrUpdateContact called for phoneNumber: ${state.phoneNumber}`);
  // Log new prioritization fields if present
  if (state.state || state.zipcode || state.hopperPriority !== undefined) {
    console.log(`Prioritization fields present - State: ${state.state}, Zipcode: ${state.zipcode}, HopperPriority: ${state.hopperPriority}`);
  }
  // Full state object for debugging if needed, but can be verbose
  // console.debug('Full state object being processed:', JSON.stringify(state, null, 2));


  const syncClient = getSyncClient(context);
  const listName = context.ACTIVE_CADENCE_CONTACTS_LIST_NAME || ACTIVE_CADENCE_CONTACTS_LIST_UNIQUE_NAME;

  try {
    // Update or create the Sync Document for the contact
    // The `update` method creates the document if it doesn't exist when a uniqueName is provided.
    await syncClient.documents(state.phoneNumber).update({
      data: state,
      ttl: SYNC_DOCUMENT_DEFAULT_TTL // Or a specific TTL based on state, e.g. if COMPLETED
    });
    console.log(`Document for ${state.phoneNumber} updated/created.`);

    // Manage membership in the active_cadence_contacts list
    if (['ACTIVE', 'PENDING'].includes(state.status)) {
      try {
        // Attempt to fetch to see if it exists. This is one way to avoid adding if already present.
        // However, Sync Lists don't have a unique constraint on value, so adding multiple times is possible.
        // A common pattern is remove-then-add to ensure it's there and only once if you manage this from one place.
        // For simplicity, we'll try to remove then add. If remove fails, it means it wasn't there.
        try {
          // This is not atomic. For true "ensure one" a backend check or more complex logic is needed.
          // However, for this list, if a number appears twice, queryContactsDueForCall would process it twice,
          // which might be acceptable or might need deduplication there.
          // Let's assume we want to ensure it's present.
          // A Sync List Item has an `index`, not a `uniqueName` or `key` based on its value.
          // So, to remove by value, we'd have to list all items and find its index.
          // This is inefficient.
          // A simpler approach for "add if not exists" is not directly supported by Sync List item creation.
          // We will simply add. If queryContactsDueForCall gets duplicates, it should handle it.
          // Or, maintain a separate Sync Set if uniqueness is critical (not a standard Sync primitive).

          // To prevent duplicates, it's better to fetch the list and check if the item exists.
          // However, this can be slow for large lists.
          // For now, we'll just add. If this causes issues, we can refine.
          // A potentially better way: use the phone number also as the item SID if Sync API allows, then fetch by SID.
          // Sync List items are identified by index.
          // Let's try creating the list item with the phone number as part of its data.
          // And rely on query side to deduplicate if necessary.
          // Or, if we want to be more robust, we would fetch all items, check, then add.
          // This is not ideal for performance.

          // A common workaround: try to create a document named `listName + '/' + state.phoneNumber`
          // If that succeeds, add to list. If it fails (already exists), then it's already "marked".
          // This is too complex for now. We will just add to the list.

          // Let's try a fetch specific item by value (not standard, but some SDKs might offer helpers or it's a map pattern)
          // Sync List items are identified by their index. To remove a specific item by value,
          // you would typically iterate through the list, find the item, and then remove it by its index.

          // Given the constraints, we'll add and suggest query-side deduplication or a more robust list management strategy if needed.
          await syncClient.lists(listName).syncListItems.create({ data: { phoneNumber: state.phoneNumber } });
          console.log(`Added ${state.phoneNumber} to ${listName} list.`);
        } catch (error) {
          // @ts-ignore
          if (error.code === 54208 || error.status === 409) { // Item already exists (not a standard Sync error for create)
            // @ts-ignore
            console.warn(`Contact ${state.phoneNumber} may already be in ${listName} list or another add race occurred:`, error.message);
          } else {
            // @ts-ignore
            console.error(`Error adding ${state.phoneNumber} to ${listName} list:`, error.message);
            // Decide if this should be a critical failure for addOrUpdateContact
          }
        }
      } catch (error) {
        // @ts-ignore
        console.error(`Error adding ${state.phoneNumber} to ${listName} list: ${error.message}`);
        // Not failing the whole operation for this, but logging it.
      }
    } else if (['COMPLETED_SUCCESS', 'COMPLETED_EXHAUSTED', 'ERROR', 'PAUSED'].includes(state.status)) {
      // Remove from active_cadence_contacts list
      // This is complex because Sync List items are removed by SID (index), not value.
      // We need to iterate and find the item.
      try {
        const listItems = await syncClient.lists(listName).syncListItems.list({ pageSize: 1000 }); // Adjust pageSize as needed
        for (const item of listItems) {
          if (item.data.phoneNumber === state.phoneNumber) {
            await syncClient.lists(listName).syncListItems(item.index.toString()).remove();
            console.log(`Removed ${state.phoneNumber} from ${listName} list (index ${item.index}).`);
            // break; // Assuming only one instance should exist. If duplicates are possible, remove all.
          }
        }
      } catch (error) {
        // @ts-ignore
        console.error(`Error removing ${state.phoneNumber} from ${listName} list: ${error.message}`);
        // Not failing the whole operation for this.
      }
    }

    return { success: true, message: 'Contact state updated.' };
  } catch (error) {
    // @ts-ignore
    console.error(`Error in addOrUpdateContact for ${state.phoneNumber}:`, error.message);
    // @ts-ignore
    return { success: false, message: error.message };
  }
}

// Internal function to get contact state
async function getContactState(
  context: MyContext,
  phoneNumber: string
): Promise<ContactCadenceState | null> {
  console.log('getContactState called for phoneNumber:', phoneNumber);
  const syncClient = getSyncClient(context);

  try {
    const doc = await syncClient.documents(phoneNumber).fetch();
    return doc.data as ContactCadenceState;
  } catch (error) {
    // @ts-ignore
    if (error.status === 404) {
      console.log(`Contact state for ${phoneNumber} not found.`);
      return null;
    }
    // @ts-ignore
    console.error(`Error fetching contact state for ${phoneNumber}:`, error.message);
    throw error; // Re-throw other errors to be caught by the main handler
  }
}

// Internal function to query contacts due for a call
async function queryContactsDueForCall(
  context: MyContext,
  timestamp: string
): Promise<ContactCadenceState[]> {
  console.log('queryContactsDueForCall called with timestamp:', timestamp);
  const syncClient = getSyncClient(context);
  const listName = context.ACTIVE_CADENCE_CONTACTS_LIST_NAME || ACTIVE_CADENCE_CONTACTS_LIST_UNIQUE_NAME;

  let allActiveContacts: ContactCadenceState[] = [];
  const processedPhoneNumbers = new Set<string>(); // To handle potential duplicates in the list if any

  try {
    console.log(`Fetching all items from Sync List: ${listName}`);
    let page = await syncClient.lists(listName).syncListItems.list({ pageSize: 100 }); // Max pageSize is 100 for Sync Lists

    while (true) {
      for (const item of page) {
        const contactPhoneNumber = item.data.phoneNumber as string;

        if (!contactPhoneNumber) {
          console.warn('Skipping item with no phoneNumber in data:', item);
          continue;
        }
        if (processedPhoneNumbers.has(contactPhoneNumber)) {
          console.warn(`Skipping duplicate phoneNumber ${contactPhoneNumber} from list ${listName}.`);
          continue;
        }
        processedPhoneNumbers.add(contactPhoneNumber);

        try {
          const contactState = await getContactState(context, contactPhoneNumber);
          if (contactState && ['ACTIVE', 'PENDING'].includes(contactState.status)) {
            allActiveContacts.push(contactState);
          } else if (!contactState) {
             console.warn(`Contact ${contactPhoneNumber} found in ${listName} but no matching Sync Document. Consider removing from list.`);
             // Optionally, try to remove it here if it implies an orphaned list item:
             // await syncClient.lists(listName).syncListItems(item.index.toString()).remove();
          }
        } catch (error) {
            // @ts-ignore
            console.error(`Error fetching state for ${contactPhoneNumber} during query: ${error.message}. Skipping this contact.`);
        }
      }
      // @ts-ignore
      if (page.hasNextPage && page.meta.key) { // Check hasNextPage and that meta.key is present for pagination
        // @ts-ignore
        page = await page.nextPage();
      } else {
        break;
      }
    }
    console.log(`Fetched ${allActiveContacts.length} active/pending contacts from list ${listName}.`);

    // Sort contacts: Primary by hopperPriority (ascending, undefined is lowest), Secondary by nextCallTimestamp (ascending)
    allActiveContacts.sort((a, b) => {
      const priorityA = a.hopperPriority ?? Number.MAX_SAFE_INTEGER;
      const priorityB = b.hopperPriority ?? Number.MAX_SAFE_INTEGER;

      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }

      // Ensure nextCallTimestamp exists for sorting, treat missing as very far in the future (or past, depending on desired behavior for nulls)
      // Here, treating null/undefined nextCallTimestamp as "not due" or "last priority" among those with same hopperPriority.
      // For actual due filtering, we check against `timestamp` later.
      const timeA = a.nextCallTimestamp ? new Date(a.nextCallTimestamp).getTime() : Number.MAX_SAFE_INTEGER;
      const timeB = b.nextCallTimestamp ? new Date(b.nextCallTimestamp).getTime() : Number.MAX_SAFE_INTEGER;

      return timeA - timeB;
    });

    console.log(`Sorted ${allActiveContacts.length} active contacts. First few after sorting:`, allActiveContacts.slice(0,5).map(c => ({p:c.phoneNumber, prio: c.hopperPriority, next: c.nextCallTimestamp})));

    // Filter by due time
    const queryDate = new Date(timestamp);
    const dueContacts = allActiveContacts.filter(contactState => {
      if (!contactState.nextCallTimestamp) return false;
      const nextCallDate = new Date(contactState.nextCallTimestamp);
      return nextCallDate <= queryDate;
    });

    console.log(`Found ${dueContacts.length} contacts due for a call after filtering by timestamp ${timestamp}.`);
    return dueContacts;

  } catch (error) {
     // @ts-ignore
    if (error.status === 404) {
        console.warn(`Sync List ${listName} not found. Returning empty array.`);
        return []; // If the list itself doesn't exist, no contacts are due from it.
    }
    // @ts-ignore
    console.error(`Error querying contacts due for call from list ${listName}:`, error.message);
    throw error; // Re-throw to be caught by main handler
  }
}
