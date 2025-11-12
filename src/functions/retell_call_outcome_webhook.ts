import { Context as ServerlessContext, ServerlessCallback, TwilioClient } from '@twilio-labs/serverless-runtime-types/types';
import { ContactCadenceState } from '../types/cadence_state';
import { getCadenceRules, CadenceRulesConfig, CadenceDispositionRule } from '../utils/cadence_rules'; // Import shared rules

import { Context as ServerlessContext, ServerlessCallback, TwilioClient } from '@twilio-labs/serverless-runtime-types/types';
import { ContactCadenceState } from '../types/cadence_state';
import { getCadenceRules, CadenceRuleSegment, CadenceRuleDelay } from '../utils/cadence_rules'; // CadenceRulesConfig, CadenceDispositionRule not directly used here but good for context
import { query as dbQuery } from '../utils/db_client';

// Define MyContext to include environment variables
interface MyContext extends ServerlessContext {
  TWILIO_SYNC_SERVICE_SID: string;
  SEGMENT_WRITE_KEY?: string;
  ACCOUNT_SID: string;
  AUTH_TOKEN: string;
  TWILIO_WORKSPACE_SID?: string;
  TWILIO_WORKFLOW_SID?: string;
  RETELL_HANDOFF_DISPOSITIONS?: string;
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

  if (!event.twilio_call_sid || !event.phone_number || !event.disposition || !event.call_ended_timestamp) {
    console.error('Validation Error: Missing required fields in Retell payload.');
    response.setStatusCode(400);
    response.setBody({ success: false, message: 'Missing required fields: twilio_call_sid, phone_number, disposition, call_ended_timestamp are required.' });
    return callback(null, response);
  }

  const twilioClient = context.getTwilioClient();
  const serverlessServiceSid = context.SERVERLESS_SERVICE_SID;
  const manageContactStateFunction = context.MANAGE_CONTACT_STATE_FUNCTION_SID || 'manage_contact_state';
  const addEventFunction = context.ADD_EVENT_FUNCTION_SID || 'add_event';
  const createTaskFunction = context.CREATE_TASK_FUNCTION_SID || 'create_task';
  const handoffDispositions = (context.RETELL_HANDOFF_DISPOSITIONS || "CALL_COMPLETED_HUMAN_HANDOFF,CALL_TRANSFERRED").split(',');

  // Determine if this is an initial call or a cadence call
  const isInitialCall = event.twilio_call_sid && event.twilio_call_sid.startsWith('initial_H');
  console.log(`Processing call outcome. CallSid: ${event.twilio_call_sid}, Is Initial Call: ${isInitialCall}`);

  try {
    if (isInitialCall) {
      // Logic for Initial Call Outcomes
      console.log('Handling outcome for an initial call.');
      const trackingIdParts = event.twilio_call_sid.match(/^initial_H(\d+)_L(\d+)_(\d+)$/);
      if (!trackingIdParts || trackingIdParts.length < 3) {
        console.error(`Could not parse hopper_id and lead_id from initial call trackingId: ${event.twilio_call_sid}`);
        response.setStatusCode(400);
        response.setBody({ success: false, message: 'Invalid initial call tracking ID format.' });
        return callback(null, response);
      }
      const hopperId = parseInt(trackingIdParts[1], 10);
      const leadIdDb = parseInt(trackingIdParts[2], 10); // lead_id from DB is likely number

      console.log(`Parsed from tracking ID - Hopper ID: ${hopperId}, Lead ID: ${leadIdDb}`);

      // Update hopper table
      try {
        await dbQuery(
          'UPDATE hopper SET status = $1, initial_call_disposition = $2, initial_call_ended_timestamp = $3, updated_at = NOW() WHERE id = $4',
          ['INITIAL_CALL_COMPLETED', event.disposition, event.call_ended_timestamp, hopperId]
        );
        console.log(`Hopper entry ${hopperId} updated to INITIAL_CALL_COMPLETED with disposition ${event.disposition}.`);
      } catch (dbError) { // @ts-ignore
        console.error(`Failed to update hopper table for ID ${hopperId}: ${dbError.message}`, dbError);
        // Continue processing to attempt to move to main cadence if possible, but log this failure.
      }

      // Fetch full lead details from leads table
      const leadDetailsResult = await dbQuery<any>(`SELECT * FROM leads WHERE id = $1`, [leadIdDb]);
      if (leadDetailsResult.length === 0) {
        console.error(`CRITICAL: Lead details not found for lead_id ${leadIdDb} (from hopper_id ${hopperId}). Cannot transition to main cadence.`);
        response.setStatusCode(500); // Internal error as we should have found the lead
        response.setBody({ success: false, message: `Lead details not found for lead_id ${leadIdDb}.` });
        return callback(null, response);
      }
      const leadData = leadDetailsResult[0];
      console.log(`Fetched lead details for lead ${leadIdDb}:`, leadData.phone_number);

      // Construct ContactCadenceState for main cadence
      let contactStateForMainCadence: ContactCadenceState = {
        phoneNumber: leadData.phone_number, // Ensure this is E.164
        leadId: String(leadIdDb),
        attemptCount: 1, // This was the first attempt
        lastCallDisposition: event.disposition,
        lastAttemptTimestamp: event.call_ended_timestamp,
        currentCallSid: undefined,
        status: 'PENDING', // Initial status, will be updated by rules
        metadata: {
          ...(leadData.metadata || {}), // If lead table has a JSON metadata field
          retellCallId: event.call_id,
          initialCallHopperId: hopperId,
          // Potentially copy other relevant fields from leadData to metadata if not directly on ContactCadenceState
          firstName: leadData.first_name, // Example
          lastName: leadData.last_name,   // Example
        },
        // Populate new prioritization fields from leadData
        state: leadData.state, // Assuming 'state' is the column name in 'leads'
        zipcode: leadData.zip_code, // Assuming 'zip_code' from 'leads' maps to 'zipcode'
        hopperPriority: leadData.hopper_priority, // Priority from hopper/lead record
      };

      console.log('Applying cadence rules to determine next step for main cadence entry...');
      const rules = getCadenceRules();
      const dispositionRuleKey = contactStateForMainCadence.lastCallDisposition || 'DEFAULT';
      const currentRule = rules[dispositionRuleKey] || rules.DEFAULT;

      // Initialize hopperPriority for the main cadence based on the rule or the lead's initial priority
      contactStateForMainCadence.hopperPriority = currentRule.defaultHopperPriority ?? contactStateForMainCadence.hopperPriority;


      if (dispositionRuleKey === 'APPOINTMENT_SCHEDULED_AI' || currentRule.finalStatusOnExhaustion === 'COMPLETED_SUCCESS') {
          contactStateForMainCadence.status = 'COMPLETED_SUCCESS';
          contactStateForMainCadence.nextCallTimestamp = undefined;
          contactStateForMainCadence.hopperPriority = undefined;
      } else if (handoffDispositions.includes(dispositionRuleKey)) {
          contactStateForMainCadence.status = 'PAUSED';
          contactStateForMainCadence.nextCallTimestamp = undefined;
      } else {
          const matchedSegment = currentRule.segments.find(segment =>
              (contactStateForMainCadence.attemptCount || 0) >= segment.callCountMin && (contactStateForMainCadence.attemptCount || 0) <= segment.callCountMax
          );
          if (matchedSegment) {
              contactStateForMainCadence.status = 'ACTIVE';
              const delay = matchedSegment.delay;
              let nextCallDate = new Date();
              nextCallDate.setDate(nextCallDate.getDate() + delay.days);
              nextCallDate.setHours(nextCallDate.getHours() + delay.hours);
              nextCallDate.setMinutes(nextCallDate.getMinutes() + delay.minutes);
              nextCallDate.setSeconds(nextCallDate.getSeconds() + delay.seconds);
              contactStateForMainCadence.nextCallTimestamp = nextCallDate.toISOString();
              if (matchedSegment.hopperPriorityOverride !== undefined) {
                  contactStateForMainCadence.hopperPriority = matchedSegment.hopperPriorityOverride;
              }
          } else {
              contactStateForMainCadence.status = currentRule.finalStatusOnExhaustion;
              contactStateForMainCadence.nextCallTimestamp = undefined;
              contactStateForMainCadence.hopperPriority = undefined;
          }
      }
      console.log('New contact state for main cadence:', JSON.stringify(contactStateForMainCadence, null, 2));

      // Invoke manage_contact_state to add/update in Sync for main cadence
      try {
        console.log(`Adding/updating contact ${contactStateForMainCadence.phoneNumber} in main cadence (Sync)...`);
        await twilioClient.serverless.services(serverlessServiceSid).functions(manageContactStateFunction).invocations.create({
          action: 'addOrUpdate',
          state: contactStateForMainCadence,
        });
        console.log('Successfully transitioned lead to main cadence.');
      } catch (syncError) { // @ts-ignore
        console.error(`Error invoking manage_contact_state for initial call transition: ${syncError.message}`, syncError);
        // This is a critical error, as the lead might not be in the main cadence system.
        // Depending on requirements, might need a retry mechanism or specific alerting.
        // For now, we'll let the function respond but the error is logged.
      }
       // Assign contactStateForMainCadence to the general contactState for Segment/TaskRouter
       contactState = contactStateForMainCadence;

    } else {
      // Existing Logic for Cadence Call Outcomes
      console.log('Handling outcome for a regular cadence call.');
      let fetchedContactState: ContactCadenceState | null = null;
      try {
        const stateResult = await twilioClient.serverless.services(serverlessServiceSid).functions(manageContactStateFunction).invocations.create({
          action: 'get',
          phoneNumber: event.phone_number,
        }); // @ts-ignore
        const stateResponse = JSON.parse(stateResult.response.body); // @ts-ignore
        if (stateResult.statusCode === 200 && stateResponse) { // @ts-ignore
          if (stateResponse.success === false && stateResponse.message === 'Contact not found') {
            fetchedContactState = null;
          } else {
            fetchedContactState = stateResponse as ContactCadenceState;
          }
        } else { // @ts-ignore
             console.warn(`Could not fetch contact state for ${event.phone_number}. Status: ${stateResult.statusCode}, Body: ${stateResult.response.body}. Assuming new contact for rule processing.`);
        }
      } catch (fetchError) { // @ts-ignore
        console.error(`Error invoking getContactState for ${event.phone_number}: ${fetchError.message}. Assuming new contact for rule processing.`, fetchError);
      }

      if (fetchedContactState) {
        contactState = { ...fetchedContactState };
        contactState.attemptCount = (contactState.attemptCount || 0) + 1;
      } else {
        contactState = {
          phoneNumber: event.phone_number,
          attemptCount: 1,
          status: 'PENDING',
          metadata: {},
        };
        console.warn(`No prior contact state found for REGULAR call to ${event.phone_number}. Initializing new state for rule processing.`);
      }

      contactState.lastCallSid = event.twilio_call_sid;
      contactState.lastCallDisposition = event.disposition;
      contactState.lastAttemptTimestamp = event.call_ended_timestamp;
      contactState.currentCallSid = undefined;
      contactState.metadata = { ...(contactState.metadata || {}), retellCallId: event.call_id, lastWebhookTimestamp: new Date().toISOString() };

      const rules = getCadenceRules();
      const dispositionRuleKey = contactState.lastCallDisposition || 'DEFAULT';
      const currentRule = rules[dispositionRuleKey] || rules.DEFAULT;

      contactState.hopperPriority = contactState.hopperPriority ?? currentRule.defaultHopperPriority;

      if (dispositionRuleKey === 'APPOINTMENT_SCHEDULED_AI' || currentRule.finalStatusOnExhaustion === 'COMPLETED_SUCCESS') {
          contactState.status = 'COMPLETED_SUCCESS';
          contactState.nextCallTimestamp = undefined;
          contactState.hopperPriority = undefined;
      } else if (handoffDispositions.includes(dispositionRuleKey)) {
          contactState.status = 'PAUSED';
          contactState.nextCallTimestamp = undefined;
      } else {
          const matchedSegment = currentRule.segments.find(segment =>
              contactState.attemptCount >= segment.callCountMin && contactState.attemptCount <= segment.callCountMax
          );
          if (matchedSegment) {
              contactState.status = 'ACTIVE';
              const delay = matchedSegment.delay;
              let nextCallDate = new Date();
              nextCallDate.setDate(nextCallDate.getDate() + delay.days);
              nextCallDate.setHours(nextCallDate.getHours() + delay.hours);
              nextCallDate.setMinutes(nextCallDate.getMinutes() + delay.minutes);
              nextCallDate.setSeconds(nextCallDate.getSeconds() + delay.seconds);
              contactState.nextCallTimestamp = nextCallDate.toISOString();
              if (matchedSegment.hopperPriorityOverride !== undefined) {
                  contactState.hopperPriority = matchedSegment.hopperPriorityOverride;
              }
          } else {
              contactState.status = currentRule.finalStatusOnExhaustion;
              contactState.nextCallTimestamp = undefined;
              contactState.hopperPriority = undefined;
          }
      }
      console.log('Updated cadence contact state:', JSON.stringify(contactState, null, 2));
      try {
        await twilioClient.serverless.services(serverlessServiceSid).functions(manageContactStateFunction).invocations.create({
          action: 'addOrUpdate',
          state: contactState,
        });
        console.log('Successfully updated contact in main cadence (Sync).');
      } catch (syncError) { // @ts-ignore
        console.error(`Error invoking manage_contact_state for regular cadence call: ${syncError.message}`, syncError);
      }
    } // End of else (isInitialCall)

    // Common downstream actions (Segment, TaskRouter) using the determined 'contactState'
    // Ensure contactState is defined from one of the branches above.
    // If isInitialCall was true, contactState was reassigned to contactStateForMainCadence.
    // If isInitialCall was false, contactState was fetched/derived from existing cadence state.
    if (!contactState) {
        console.error("CRITICAL: contactState is not defined after initial/cadence call processing branches. This should not happen.");
        // Fallback or error response if contactState is somehow not set
        response.setStatusCode(500);
        response.setBody({ success: false, message: "Internal error: contact state not resolved."});
        return callback(null, response);
    }

    // Log event to Segment
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
