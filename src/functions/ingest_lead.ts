import { Context, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';
import { query as dbQuery } from '../utils/db_client'; // Renamed to dbQuery to avoid conflict if any
import { PoolClient, QueryResultRow } from 'pg'; // For potential future transaction use

// Define MyContext if specific environment variables beyond DB are needed for this function
// For now, assuming DB env vars are handled by db_client.ts
interface MyContext extends Context {}

// Define an interface for the expected lead data payload.
// This is a partial example; all 55 fields should be listed.
// Marking many as optional for flexibility during ingestion.
interface LeadData {
  phone_number: string; // E.164 format is ideal
  first_name?: string;
  last_name?: string;
  email?: string;
  address_1?: string;
  city?: string;
  state?: string; // 2-letter US state code
  zip_code?: string; // Use zip_code to match table, not zipcode from ContactCadenceState
  // ... add all 55 fields here, e.g.:
  date_of_birth?: string; // YYYY-MM-DD
  gender?: string;
  medicare_id?: string;
  medicaid_id?: string;
  insurance_carrier?: string;
  insurance_plan_name?: string;
  policy_id?: string;
  // Add all other fields from the provided list (total 55)
  // For brevity in this example, only a few are listed.
  // Ensure all actual field names match your DB schema.
  // Example of a custom field:
  custom_field_1?: string;
  // Assume hopperPriority is also part of this payload if it's set at ingestion
  hopper_priority?: number;
}

// Helper function to build INSERT query for the leads table
// This is crucial for managing a large number of fields.
function buildLeadInsertQuery(leadData: LeadData): { text: string; values: any[] } {
  // Define all potential fields that can be inserted. This must match your DB table columns.
  // Order matters for the $1, $2 placeholders.
  const allLeadFields: (keyof LeadData)[] = [
    'phone_number', 'first_name', 'last_name', 'email', 'address_1', 'city', 'state', 'zip_code',
    'date_of_birth', 'gender', 'medicare_id', 'medicaid_id', 'insurance_carrier',
    'insurance_plan_name', 'policy_id', 'custom_field_1', 'hopper_priority'
    // ... ADD ALL 55 field names here in the correct order
  ];

  const providedFields: string[] = [];
  const providedValues: any[] = [];
  const placeholders: string[] = [];

  let placeholderIndex = 1;
  for (const field of allLeadFields) {
    if (leadData[field] !== undefined && leadData[field] !== null) {
      providedFields.push(field); // For column names: ensure field matches column name exactly
      providedValues.push(leadData[field]);
      placeholders.push(`$${placeholderIndex++}`);
    }
    // If you want to insert NULL for fields not provided, you'd always push the field
    // and push leadData[field] (which would be undefined, then ensure your DB driver handles undefined as NULL or explicitly map it)
    // For this example, we only insert fields that are actually provided in the payload.
    // This assumes your DB columns have defaults or are nullable.
  }

  if (providedFields.length === 0) {
    throw new Error('No valid lead data fields provided for insert.');
  }

  const text = `INSERT INTO leads (${providedFields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`;
  return { text, values: providedValues };
}


export const handler: ServerlessFunctionSignature<MyContext, LeadData> = async (
  context,
  event, // event is the request body (LeadData)
  callback
) => {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  console.log('Ingest lead request received:', event);

  // Validate Input
  if (!event.phone_number) {
    console.warn('Ingest lead validation failed: Missing phone_number.');
    response.setStatusCode(400);
    response.setBody({ success: false, reason_code: 'MISSING_PHONE_NUMBER', message: 'Phone number is required.' });
    return callback(null, response);
  }
  // Normalize phone number if necessary (e.g., ensure E.164, though not done here)

  try {
    // Database Operations
    // Step 1: Duplicate Check
    console.log(`Checking for duplicate lead with phone number: ${event.phone_number}`);
    const existingLeads = await dbQuery<{ id: string }>('SELECT id FROM leads WHERE phone_number = $1', [event.phone_number]);

    if (existingLeads.length > 0) {
      console.log(`Duplicate lead found for phone number ${event.phone_number}. Lead ID: ${existingLeads[0].id}`);
      response.setStatusCode(200); // Or 409 Conflict
      response.setBody({
        success: false,
        reason_code: 'DUPLICATE_LEAD',
        message: `Lead with phone number ${event.phone_number} already exists.`,
        lead_id: existingLeads[0].id
      });
      return callback(null, response);
    }

    // Step 2: Store New Lead (if not duplicate)
    console.log(`No duplicate found for ${event.phone_number}. Proceeding to insert.`);
    const { text: insertLeadQuery, values: leadValues } = buildLeadInsertQuery(event);

    console.log(`Executing lead insert: ${insertLeadQuery}`, leadValues);
    const insertResult = await dbQuery<{ id: string }>(insertLeadQuery, leadValues);

    if (!insertResult || insertResult.length === 0 || !insertResult[0].id) {
      console.error('Lead insertion failed or did not return ID.', insertResult);
      throw new Error('Lead insertion failed to return a new ID.');
    }
    const newLeadId = insertResult[0].id;
    console.log(`New lead inserted with ID: ${newLeadId}`);

    // Step 3: Create Initial Hopper Entry
    const initialHopperStatus = 'PENDING_INITIAL_CALL'; // Or some other defined initial status
    console.log(`Adding lead ${newLeadId} to hopper with status ${initialHopperStatus}.`);
    await dbQuery(
      'INSERT INTO hopper (lead_id, hopper_entry_timestamp, status, priority) VALUES ($1, NOW(), $2, $3)',
      [newLeadId, initialHopperStatus, event.hopper_priority ?? null] // Use hopper_priority from payload, or null
    );
    console.log(`Lead ${newLeadId} added to hopper successfully.`);

    // Success Response
    response.setStatusCode(201); // Created
    response.setBody({
      success: true,
      reason_code: 'LEAD_ADDED',
      message: 'Lead added successfully and placed in hopper.',
      lead_id: newLeadId
    });
    return callback(null, response);

  } catch (error) {
    // @ts-ignore
    console.error('Error during lead ingestion process:', error.message, error.stack, error);
    response.setStatusCode(500);
    response.setBody({
      success: false,
      reason_code: 'INTERNAL_SERVER_ERROR',
      // @ts-ignore
      message: `An unexpected error occurred: ${error.message}`
    });
    return callback(null, response);
  }
};

// Example of how you might call this function (e.g. from Postman or curl):
// POST to /ingest_lead
// Body (JSON):
// {
//   "phone_number": "+12345678901",
//   "first_name": "John",
//   "last_name": "Doe",
//   "email": "john.doe@example.com",
//   "city": "Anytown",
//   "state": "CA",
//   "zip_code": "90210",
//   "hopper_priority": 10
//   // ... other fields
// }
