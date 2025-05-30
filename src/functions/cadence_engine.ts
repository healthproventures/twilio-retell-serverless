import { Context as ServerlessContext, ServerlessCallback, TwilioClient } from '@twilio-labs/serverless-runtime-types/types';
import { ContactCadenceState } from '../types/cadence_state';
import { getCadenceRules } from '../utils/cadence_rules'; // Import shared rules

// Define MyContext for this function (ensure it matches or is compatible with shared definitions if any)
interface MyContext extends ServerlessContext {
  TWILIO_SYNC_SERVICE_SID: string;
  SERVERLESS_SERVICE_SID: string;
  MANAGE_CONTACT_STATE_FUNCTION_SID?: string;
  START_CALL_FUNCTION_SID?: string;
  RETELL_AGENT_ID_MEDICARE: string;
  CADENCE_CALLER_ID: string;
}

export const handler = async (
  context: MyContext,
  event: {}, // This function is likely triggered by a scheduler, not a specific event payload
  callback: ServerlessCallback
) => {
  console.log('Cadence Engine invoked.');
  const twilioClient = context.getTwilioClient();
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  const serverlessServiceSid = context.SERVERLESS_SERVICE_SID;
  const manageContactStateFunction = context.MANAGE_CONTACT_STATE_FUNCTION_SID || 'manage_contact_state';
  const startCallFunction = context.START_CALL_FUNCTION_SID || 'start_call'; // Assuming 'start_call.protected.ts' is deployed as 'start_call'

  let processedContacts = 0;
  let initiatedCalls = 0;
  let errorsEncountered = 0;

  try {
    // Step 1: Fetch Due Contacts
    console.log('Fetching due contacts...');
    const currentTimestamp = new Date().toISOString();
    let dueContacts: ContactCadenceState[] = [];

    try {
      const dueContactsResult = await twilioClient.serverless
        .services(serverlessServiceSid)
        .functions(manageContactStateFunction)
        .invocations.create({
          action: 'queryDue',
          timestamp: currentTimestamp,
        });
      
      // @ts-ignore
      if (dueContactsResult.statusCode === 200) {
        // @ts-ignore
        const rawResponse = JSON.parse(dueContactsResult.response.body);
        dueContacts = rawResponse as ContactCadenceState[]; // Assuming direct array response
        console.log(`Found ${dueContacts.length} contacts due for a call.`);
      } else {
        // @ts-ignore
        console.error(`Error fetching due contacts. Status: ${dueContactsResult.statusCode}, Body: ${dueContactsResult.response.body}`);
        // @ts-ignore
        throw new Error(`Failed to query due contacts: ${dueContactsResult.response.body}`);
      }
    } catch (e) {
        // @ts-ignore
        console.error('Error invoking queryContactsDueForCall:', e.message, e);
        errorsEncountered++;
        // @ts-ignore
        response.setStatusCode(500);
        // @ts-ignore
        response.setBody({ success: false, message: `Error fetching due contacts: ${e.message}` });
        return callback(null, response);
    }

    const rules = getCadenceRules();

    // Step 2: Process Each Due Contact
    for (const contact of dueContacts) {
      processedContacts++;
      console.log(`Processing contact: ${contact.phoneNumber}, current status: ${contact.status}, attempts: ${contact.attemptCount}, disposition: ${contact.lastCallDisposition}`);

      // Determine rule: use NEW_LEAD if no attempts yet, otherwise use last disposition or DEFAULT
      const ruleKey = contact.attemptCount === 0 && !contact.lastCallDisposition 
                      ? 'NEW_LEAD' 
                      : contact.lastCallDisposition || 'DEFAULT';
      const dispositionRule = rules[ruleKey] || rules.DEFAULT;
      
      console.log(`Applying rule: ${ruleKey} (max attempts: ${dispositionRule.maxAttempts})`);

      // Check Max Attempts FOR THE CURRENT DISPOSITION SEQUENCE.
      // The webhook should reset attemptCount or change disposition if a different outcome occurs.
      // This engine checks if the *current* sequence of attempts for a *persistent* disposition has been exhausted.
      // However, `contact.attemptCount` is the TOTAL attempts for the lead.
      // This needs refinement. The `manage_contact_state` should store `currentDispositionAttemptCount`.
      // For now, let's assume `contact.attemptCount` is the total attempts for the lead,
      // and rules.maxAttempts refers to total attempts for the lead under this cadence path.
      // This is a simplification. A more robust system would track attempts *per disposition sequence*.
      // Let's proceed with `contact.attemptCount` as total for now.

      if (contact.attemptCount >= dispositionRule.maxAttempts) {
        console.log(`Max attempts (${dispositionRule.maxAttempts}) reached for ${contact.phoneNumber} under rule ${ruleKey}.`);
        const finalState: Partial<ContactCadenceState> = {
          phoneNumber: contact.phoneNumber,
          status: dispositionRule.finalStatusOnExhaustion,
          nextCallTimestamp: undefined, // Clear next call time
          currentCallSid: undefined,    // Clear current call SID
        };
        try {
          await twilioClient.serverless
            .services(serverlessServiceSid)
            .functions(manageContactStateFunction)
            .invocations.create({ action: 'addOrUpdate', state: finalState });
          console.log(`Contact ${contact.phoneNumber} moved to final status: ${finalState.status}`);
        } catch (e) {
            // @ts-ignore
            console.error(`Error updating contact ${contact.phoneNumber} to final status: ${e.message}`);
            errorsEncountered++;
        }
        continue; // Move to the next contact
      }

      // It's time to call
      console.log(`Preparing to call ${contact.phoneNumber}. Attempt (overall): ${contact.attemptCount + 1}`);
      const newCurrentCallSid = `TEMP_${Date.now()}_${contact.phoneNumber}`;

      const stateUpdateForCallAttempt: Partial<ContactCadenceState> = {
        phoneNumber: contact.phoneNumber,
        currentCallSid: newCurrentCallSid,
        // status remains 'ACTIVE' or 'PENDING' (it was this to be queried)
        // lastAttemptTimestamp is set by the webhook upon actual call outcome. Engine marks processing time.
        // nextCallTimestamp is cleared/managed by webhook.
        // attemptCount is incremented by webhook.
      };

      try {
        console.log(`Updating contact ${contact.phoneNumber} with new currentCallSid: ${newCurrentCallSid}`);
        await twilioClient.serverless
          .services(serverlessServiceSid)
          .functions(manageContactStateFunction)
          .invocations.create({ action: 'addOrUpdate', state: stateUpdateForCallAttempt });
        console.log(`Successfully updated contact ${contact.phoneNumber} before initiating call.`);
      } catch (e) {
        // @ts-ignore
        console.error(`Error updating contact ${contact.phoneNumber} before call: ${e.message}. Skipping call attempt.`);
        errorsEncountered++;
        continue; // Skip to next contact if we can't mark it as being processed
      }

      // Initiate Call via start_call function
      const callParameters = {
        To: contact.phoneNumber,
        From: context.CADENCE_CALLER_ID,
        agent_id: context.RETELL_AGENT_ID_MEDICARE,
        CallSid: newCurrentCallSid, // Pass the tracking ID as the main CallSid parameter
        // Any additional metadata for Retell (not for overriding CallSid for start.ts)
        // can be passed in a separate 'retell_metadata' field if start.ts is designed to forward it.
        // For now, assuming start.ts primarily uses event.CallSid for Retell's twilio_call_sid.
        // If start.ts needs other specific metadata from cadence_engine, it would be added here.
        // e.g., RetellCustomMetadata: { lead_id: contact.leadId, source: 'cadence_engine' }
        // This depends on start.ts's expected event structure.
        // The key change is `CallSid: newCurrentCallSid`.
        // If start.ts also needs lead_id directly in its event (not nested in Retell metadata):
        lead_id: contact.leadId // Assuming start.ts can accept this at the top level of its event.
                                // Otherwise, it would need to be nested if start.ts expects it that way
                                // for its own internal logic or for Retell's general metadata field.
                                // For now, the critical part is `CallSid`.
                                // Let's assume start.ts will pick up `lead_id` if present at top level.
      };

      console.log(`Initiating call to ${contact.phoneNumber} with params:`, JSON.stringify(callParameters, null, 2));
      try {
        const startCallResult = await twilioClient.serverless
          .services(serverlessServiceSid)
          .functions(startCallFunction)
          .invocations.create(callParameters);

        // @ts-ignore
        const startCallResponse = JSON.parse(startCallResult.response.body);
        // @ts-ignore
        if (startCallResult.statusCode === 200 && startCallResponse.success) {
          initiatedCalls++;
          // @ts-ignore
          console.log(`Call initiated successfully to ${contact.phoneNumber}. Twilio Call SID (from start.ts): ${startCallResponse.call_sid}`);
        } else {
          // @ts-ignore
          console.error(`Failed to initiate call to ${contact.phoneNumber}. Status: ${startCallResult.statusCode}, Body: ${startCallResult.response.body}`);
          errorsEncountered++;
          // Call initiation failed. Revert currentCallSid or mark error.
          const revertState: Partial<ContactCadenceState> = {
            phoneNumber: contact.phoneNumber,
            currentCallSid: undefined, // Clear the temp SID
            status: 'ERROR', // Or 'PENDING' with a short retry
            // Consider setting nextCallTimestamp for a short retry here for initiation failure
            // lastCallDisposition: 'ERROR_INITIATION_FAILED', // Custom disposition
          };
          try {
            await twilioClient.serverless
              .services(serverlessServiceSid)
              .functions(manageContactStateFunction)
              .invocations.create({ action: 'addOrUpdate', state: revertState });
            console.log(`Reverted/Error state for ${contact.phoneNumber} due to call initiation failure.`);
          } catch (revertError) {
            // @ts-ignore
            console.error(`Error reverting state for ${contact.phoneNumber} after initiation failure: ${revertError.message}`);
          }
        }
      } catch (e) {
        // @ts-ignore
        console.error(`Critical error invoking ${startCallFunction} for ${contact.phoneNumber}: ${e.message}`, e);
        errorsEncountered++;
        // Also revert state here
        const criticalRevertState: Partial<ContactCadenceState> = {
            phoneNumber: contact.phoneNumber,
            currentCallSid: undefined,
            status: 'ERROR',
        };
        try {
            await twilioClient.serverless
              .services(serverlessServiceSid)
              .functions(manageContactStateFunction)
              .invocations.create({ action: 'addOrUpdate', state: criticalRevertState });
        } catch (revertE) { /* ignore */ }
      }
    } // End of loop through contacts

    const summaryMessage = `Cadence Engine processed ${processedContacts} contacts. Initiated ${initiatedCalls} calls. Encountered ${errorsEncountered} errors.`;
    console.log(summaryMessage);
    response.setStatusCode(200);
    response.setBody({ success: true, message: summaryMessage, processedContacts, initiatedCalls, errorsEncountered });
    return callback(null, response);

  } catch (error) {
    // @ts-ignore
    console.error('Critical unhandled error in Cadence Engine:', error.message, error.stack);
    response.setStatusCode(500);
    // @ts-ignore
    response.setBody({ success: false, message: `Internal Server Error: ${error.message}` });
    return callback(null, response);
  }
};
