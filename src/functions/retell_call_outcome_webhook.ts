import { Context as ServerlessContext, ServerlessCallback, TwilioClient } from '@twilio-labs/serverless-runtime-types/types';
import { ContactCadenceState } from '../types/cadence_state';
import { getCadenceRules, CadenceRulesConfig, CadenceDispositionRule } from '../utils/cadence_rules'; // Import shared rules

// Define MyContext to include environment variables
interface MyContext extends ServerlessContext {
  TWILIO_SYNC_SERVICE_SID: string;
  SEGMENT_WRITE_KEY?: string;
  ACCOUNT_SID: string; // Needed for create_task if not using client from context directly for specific calls
  AUTH_TOKEN: string;  // Needed for create_task if not using client from context directly for specific calls
  TWILIO_WORKSPACE_SID?: string;
  TWILIO_WORKFLOW_SID?: string;
  RETELL_HANDOFF_DISPOSITIONS?: string; // Comma-separated list, e.g., "CALL_COMPLETED_HUMAN_HANDOFF,CALL_TRANSFERRED"
  MANAGE_CONTACT_STATE_FUNCTION_SID?: string;
  ADD_EVENT_FUNCTION_SID?: string;
  CREATE_TASK_FUNCTION_SID?: string;
  SERVERLESS_SERVICE_SID: string;
}

// Interface for the expected Retell webhook payload
// This should be updated based on actual Retell documentation.
// This is a simplified example; refer to Retell documentation for the exact structure.
interface RetellCallOutcomePayload {
  call_id: string;                  // Retell's internal call ID
  twilio_call_sid: string;          // Twilio Call SID
  phone_number: string;             // E.164 format contact phone number
  disposition: string;              // e.g., "CALL_COMPLETED_HUMAN_HANDOFF", "CALL_COMPLETED_NO_ANSWER", "CALL_FAILED_VOICEMAIL_DETECTED"
  call_ended_timestamp: string;     // ISO 8601 timestamp
  transcript?: string;
  transcript_summary?: string;      // Summary of the conversation if available
  recording_url?: string;
  metadata?: { [key: string]: any }; // Any custom metadata passed to Retell or generated
  // Add other fields as per Retell's actual payload structure
}

// Response from invoking another serverless function
interface InvokedFunctionResponse {
  success: boolean;
  message?: string;
  data?: any; // Adjust based on what the invoked function returns
}


export const handler = async (
  context: MyContext,
  event: RetellCallOutcomePayload, // Assuming event comes directly as payload
  callback: ServerlessCallback
) => {
  console.log('Retell Call Outcome Webhook received:', JSON.stringify(event, null, 2));

  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  // Basic payload validation
  if (!event.twilio_call_sid || !event.phone_number || !event.disposition || !event.call_ended_timestamp) {
    console.error('Validation Error: Missing required fields in Retell payload.');
    response.setStatusCode(400);
    response.setBody({ success: false, message: 'Missing required fields: twilio_call_sid, phone_number, disposition, call_ended_timestamp are required.' });
    return callback(null, response);
  }

  const twilioClient = context.getTwilioClient();
  const serverlessServiceSid = context.SERVERLESS_SERVICE_SID;
  const manageContactStateFunction = context.MANAGE_CONTACT_STATE_FUNCTION_SID || 'manage_contact_state';

  try {
    // Step 1: Fetch current contact state
    console.log(`Fetching contact state for ${event.phone_number}...`);
    let fetchedContactState: ContactCadenceState | null = null;
    try {
      const stateResult = await twilioClient.serverless.services(serverlessServiceSid).functions(manageContactStateFunction).invocations.create({
        action: 'get',
        phoneNumber: event.phone_number,
      });
      // @ts-ignore
      const stateResponse = JSON.parse(stateResult.response.body);
      // @ts-ignore
      if (stateResult.statusCode === 200 && stateResponse) {
        // @ts-ignore
        if (stateResponse.success === false && stateResponse.message === 'Contact not found') {
          fetchedContactState = null;
          console.log(`Contact ${event.phone_number} not found.`);
        } else {
          fetchedContactState = stateResponse as ContactCadenceState;
          console.log('Current contact state fetched:', fetchedContactState);
        }
      } else { // @ts-ignore
        console.warn(`Could not fetch contact state for ${event.phone_number}. Status: ${stateResult.statusCode}, Body: ${stateResult.response.body}. Assuming new contact.`);
        fetchedContactState = null;
      }
    } catch (fetchError) { // @ts-ignore
      console.error(`Error invoking getContactState for ${event.phone_number}: ${fetchError.message}. Assuming new contact.`, fetchError);
      fetchedContactState = null;
    }

    // Step 2: Initialize or update contact state based on outcome
    let contactState: ContactCadenceState;
    if (fetchedContactState) {
      contactState = { ...fetchedContactState };
      contactState.attemptCount = (contactState.attemptCount || 0) + 1;
    } else {
      // New contact: initialize state
      contactState = {
        phoneNumber: event.phone_number,
        attemptCount: 1,
        status: 'PENDING', // Initial status, will be updated by rules
        // leadId, metadata can be set if provided in webhook or via other means
      };
      console.warn(`No prior contact state found for ${event.phone_number}. Initializing new state.`);
    }

    // Update common fields based on webhook payload
    contactState.lastCallSid = event.twilio_call_sid;
    contactState.lastCallDisposition = event.disposition;
    contactState.lastAttemptTimestamp = event.call_ended_timestamp;
    contactState.currentCallSid = undefined; // Clear the specific call SID for this attempt
    contactState.metadata = { ...(contactState.metadata || {}), retellCallId: event.call_id, lastWebhookTimestamp: new Date().toISOString() };


    // Step 3: Apply Cadence Rules for Status and nextCallTimestamp
    const cadenceRules = getCadenceRules();
    const dispositionKey = contactState.lastCallDisposition || 'DEFAULT';
    // Use 'NEW_LEAD' rule if it's the very first attempt outcome for a lead not previously in system,
    // otherwise use specific disposition or DEFAULT.
    // The `contactState.attemptCount` is now 1 for the first successfully processed call.
    const effectiveRuleKey = (contactState.attemptCount === 1 && !fetchedContactState) ? 'NEW_LEAD' : dispositionKey;
    const rule = cadenceRules[effectiveRuleKey] || cadenceRules.DEFAULT;

    console.log(`Applying rule: ${effectiveRuleKey} for disposition: ${contactState.lastCallDisposition}. Attempt count now: ${contactState.attemptCount}`);

    // Check for specific terminal dispositions that override attempt-based logic
    const handoffDispositions = (context.RETELL_HANDOFF_DISPOSITIONS || "CALL_COMPLETED_HUMAN_HANDOFF,CALL_TRANSFERRED").split(',');
    
    if (rule.finalStatusOnExhaustion === 'COMPLETED_SUCCESS' && rule.maxAttempts === 1) { // E.g. APPOINTMENT_SCHEDULED_AI
        contactState.status = 'COMPLETED_SUCCESS';
        contactState.nextCallTimestamp = undefined;
        console.log(`Terminal success disposition ${dispositionKey}. Status: COMPLETED_SUCCESS.`);
    } else if (handoffDispositions.includes(event.disposition)) {
        contactState.status = 'PAUSED'; // Or rule.finalStatusOnExhaustion if defined for handoff dispositions
        contactState.nextCallTimestamp = undefined;
        console.log(`Handoff disposition ${event.disposition}. Status: PAUSED.`);
    } else if (contactState.attemptCount >= rule.maxAttempts) {
        contactState.status = rule.finalStatusOnExhaustion;
        contactState.nextCallTimestamp = undefined;
        console.log(`Max attempts (${rule.maxAttempts}) reached for rule ${effectiveRuleKey}. Status: ${contactState.status}.`);
    } else {
        contactState.status = 'ACTIVE'; // Ready for next attempt
        // `contactState.attemptCount` is number of attempts *completed*.
        // So, `rule.attempts[contactState.attemptCount]` is the delay for the *next* attempt.
        const nextAttemptDelayConfigIndex = contactState.attemptCount; // If 1 attempt done, use index 1 for 2nd attempt's delay.
                                                                      // This seems off, rule.attempts[0] is for 1st retry (2nd call)
                                                                      // If contactState.attemptCount is 1 (1st call done), next call is 2nd attempt, so delay is rule.attempts[0] for that.
                                                                      // No, rule.attempts[0] is delay for 1st attempt in sequence, rule.attempts[1] for 2nd.
                                                                      // The rule applies to the *sequence following this disposition*.
                                                                      // So, if current disposition is NO_ANSWER, and attemptCount for NO_ANSWER sequence is 1,
                                                                      // then use rule.attempts[0].delayMinutes.
                                                                      // THIS REQUIRES attempt count *per disposition sequence*, not global.
                                                                      // SIMPLIFICATION: Using global attemptCount to pick from the array.
                                                                      // This means rule.attempts should be long enough for max global attempts.
                                                                      // Let's use contactState.attemptCount -1 as index for current attempt's outcome processing
                                                                      // and contactState.attemptCount for NEXT attempt's schedule.

        if (nextAttemptDelayConfigIndex < rule.attempts.length) {
            const delayMinutes = rule.attempts[nextAttemptDelayConfigIndex].delayMinutes;
            contactState.nextCallTimestamp = new Date(Date.now() + delayMinutes * 60000).toISOString();
            console.log(`Next call scheduled for ${contactState.phoneNumber} at ${contactState.nextCallTimestamp} (delay: ${delayMinutes} mins).`);
        } else {
            // Fallback if attempts array is shorter than maxAttempts (rules misconfiguration)
            contactState.status = rule.finalStatusOnExhaustion;
            contactState.nextCallTimestamp = undefined;
            console.warn(`Attempt array for rule ${effectiveRuleKey} is too short for attempt number ${contactState.attemptCount + 1}. Setting to final status: ${contactState.status}.`);
        }
    }

    // Step 4: Save updated state
    try {
      console.log(`Updating contact state for ${event.phone_number} with final computed state:`, contactState);
      const updateResult = await twilioClient.serverless.services(serverlessServiceSid).functions(manageContactStateFunction).invocations.create({
        action: 'addOrUpdate',
        state: contactState, // Send the complete, updated state
      });
      // @ts-ignore
      console.log('Contact state update invocation result:', JSON.parse(updateResult.response.body));
    } catch (updateError) { // @ts-ignore
      console.error(`Error invoking addOrUpdateContact for ${event.phone_number}: ${updateError.message}`, updateError);
    }

    // Step 5: Log event to Segment
    const addEventFunction = context.ADD_EVENT_FUNCTION_SID || 'add_event';
    if (context.SEGMENT_WRITE_KEY && addEventFunction) {
      const eventProperties = {
        call_sid: event.twilio_call_sid,
        retell_call_id: event.call_id,
        phone_number: event.phone_number,
        disposition: event.disposition,
        summary: event.transcript_summary,
        call_ended_timestamp: event.call_ended_timestamp,
        attempt_count: contactState.attemptCount,
        final_status: contactState.status,
        next_call_timestamp: contactState.nextCallTimestamp,
      };
      try {
        console.log('Logging event to Segment:', eventProperties);
        // @ts-ignore
        await twilioClient.serverless.services(serverlessServiceSid).functions(addEventFunction).invocations.create({
          userId: event.phone_number, 
          eventName: 'Retell Call Outcome Processed',
          properties: eventProperties,
        });
        console.log('Segment event logged successfully.');
      } catch (segmentError) { // @ts-ignore
        console.error('Error logging event to Segment:', segmentError.message);
      }
    }

    // Step 6: Trigger TaskRouter for Human Handoff
    const createTaskFunction = context.CREATE_TASK_FUNCTION_SID || 'create_task';
    // Check against updated contactState.status as rules might have set it to PAUSED for handoff
    if (context.TWILIO_WORKSPACE_SID && context.TWILIO_WORKFLOW_SID && createTaskFunction && 
        (handoffDispositions.includes(event.disposition) || contactState.status === 'PAUSED' && handoffDispositions.includes(contactState.lastCallDisposition || ''))) {
      const taskAttributes = {
        twilio_call_sid: event.twilio_call_sid,
        retell_call_id: event.call_id,
        phone_number: event.phone_number,
        disposition: event.disposition, // The actual disposition from Retell
        current_contact_status: contactState.status,
        transcript_summary: event.transcript_summary,
        customer_name: event.metadata?.customer_name || contactState.metadata?.customer_name || 'Unknown',
        lead_id: contactState.leadId,
      };
      try {
        console.log('Triggering TaskRouter task for handoff:', taskAttributes);
        // @ts-ignore
        await twilioClient.serverless.services(serverlessServiceSid).functions(createTaskFunction).invocations.create({
          attributes: taskAttributes,
          workflowSid: context.TWILIO_WORKFLOW_SID,
        });
        console.log('TaskRouter task created successfully for handoff.');
      } catch (taskRouterError) { // @ts-ignore
        console.error('Error creating TaskRouter task:', taskRouterError.message);
      }
    }

    // Step 7: Respond to Webhook
    response.setStatusCode(200);
    response.setBody({ success: true, message: 'Webhook received and processed.' });
    return callback(null, response);

  } catch (error) {
    // @ts-ignore
    console.error('Unhandled error in Retell Call Outcome Webhook:', error.message, error.stack);
    response.setStatusCode(500);
    // @ts-ignore
    response.setBody({ success: false, message: `Internal Server Error: ${error.message}` });
    return callback(null, response);
  }
};
