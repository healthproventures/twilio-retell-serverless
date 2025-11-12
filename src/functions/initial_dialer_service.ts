import { Context as ServerlessContext, ServerlessCallback, ServerlessFunctionSignature, TwilioClient } from '@twilio-labs/serverless-runtime-types/types';
import { query as dbQuery } from '../utils/db_client';

interface MyContext extends ServerlessContext {
  INITIAL_CALL_CALLER_ID: string;
  RETELL_AGENT_ID_INITIAL_CALL: string;
  START_CALL_FUNCTION_SID: string; // SID for start.ts
  SERVERLESS_SERVICE_SID: string;
}

interface HopperResult {
  hopper_id: number;
  lead_id: string;
}

interface LeadDetails {
  id: string;
  phone_number: string;
  first_name?: string;
  last_name?: string;
  // Add any other fields Retell agent might use
}

export const handler: ServerlessFunctionSignature<MyContext, {}> = async (
  context,
  event, // This function is likely triggered by a scheduler, no specific event payload needed
  callback
) => {
  console.log('Initial Dialer Service invoked.');
  const twilioClient = context.getTwilioClient();
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  let hopperEntry: HopperResult | null = null;

  try {
    // Step 1: Fetch and lock a lead from the hopper atomically
    const fetchAndLockQuery = `
      UPDATE hopper
      SET status = 'PROCESSING_INITIAL_CALL', updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM hopper
        WHERE status = 'PENDING_INITIAL_CALL'
        ORDER BY hopper_entry_timestamp ASC, priority ASC NULLS LAST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id AS hopper_id, lead_id;
    `;
    // Added priority to ORDER BY: lower number = higher priority, NULLS LAST

    console.log('Attempting to fetch and lock a lead from hopper...');
    const hopperResults = await dbQuery<HopperResult>(fetchAndLockQuery);

    if (hopperResults.length === 0) {
      console.log('No leads in hopper with status PENDING_INITIAL_CALL.');
      response.setBody({ success: true, status: 'no_leads_found', message: 'No leads in hopper to process.' });
      return callback(null, response);
    }

    hopperEntry = hopperResults[0];
    console.log(`Processing hopper entry ID: ${hopperEntry.hopper_id}, Lead ID: ${hopperEntry.lead_id}`);

    // Step 2: Fetch Full Lead Details
    const leadDetailsResults = await dbQuery<LeadDetails>(
      'SELECT id, phone_number, first_name, last_name FROM leads WHERE id = $1',
      [hopperEntry.lead_id]
    );

    if (leadDetailsResults.length === 0) {
      console.error(`CRITICAL: Lead details not found for lead_id ${hopperEntry.lead_id} (hopper_id ${hopperEntry.hopper_id}). Data inconsistency.`);
      // Update hopper status to ERROR_PROCESSING to prevent retries on this inconsistent data
      await dbQuery("UPDATE hopper SET status = 'ERROR_PROCESSING_LEAD_NOT_FOUND', updated_at = NOW() WHERE id = $1", [hopperEntry.hopper_id]);
      response.setStatusCode(500);
      response.setBody({ success: false, status: 'error_lead_not_found', message: `Lead details not found for lead_id ${hopperEntry.lead_id}.` });
      return callback(null, response);
    }
    const leadDetails = leadDetailsResults[0];
    console.log(`Fetched lead details for ${leadDetails.phone_number}`);

    // Step 3: Initiate Call
    const trackingId = `initial_H${hopperEntry.hopper_id}_L${hopperEntry.lead_id}_${Date.now()}`;
    console.log(`Generated tracking ID for call: ${trackingId}`);

    // Store trackingId in hopper (initial_call_provider_sid for now)
    await dbQuery('UPDATE hopper SET initial_call_provider_sid = $1, updated_at = NOW() WHERE id = $2', [trackingId, hopperEntry.hopper_id]);
    console.log(`Stored tracking ID ${trackingId} in hopper entry ${hopperEntry.hopper_id}`);

    const startCallParams = {
      To: leadDetails.phone_number,
      From: context.INITIAL_CALL_CALLER_ID,
      agent_id: context.RETELL_AGENT_ID_INITIAL_CALL,
      CallSid: trackingId, // This is the crucial tracking ID
      // Optional: Pass additional lead data if start.ts or Retell agent supports it
      // This metadata should be structured as expected by start.ts if it forwards it.
      RetellCustomMetadata: {
        lead_id: leadDetails.id,
        hopper_id: hopperEntry.hopper_id,
        first_name: leadDetails.first_name,
        last_name: leadDetails.last_name,
        call_type: 'initial_dialer'
      }
    };

    console.log(`Invoking start.ts (function SID: ${context.START_CALL_FUNCTION_SID}) with params:`, startCallParams);

    let callInitiationError = false;
    try {
      const startCallResult = await twilioClient.serverless
        .services(context.SERVERLESS_SERVICE_SID)
        .functions(context.START_CALL_FUNCTION_SID)
        .invocations.create(startCallParams);

      // @ts-ignore
      const startCallResponse = JSON.parse(startCallResult.response.body);
      // @ts-ignore
      if (startCallResult.statusCode === 200 && startCallResponse.success) {
        // @ts-ignore
        console.log(`Call initiated successfully via start.ts for lead ${leadDetails.id}. Actual Twilio Call SID: ${startCallResponse.call_sid}`);
        // The hopper status remains 'PROCESSING_INITIAL_CALL'.
        // The retell_call_outcome_webhook will be responsible for the next status update (e.g., to 'COMPLETED_INITIAL_CALL_ATTEMPT', 'CONTACTED_INITIAL')
        // and moving the lead to the main cadence_state / Sync Document.
        response.setBody({
            success: true,
            status: 'call_initiated',
            message: `Call initiated for lead ID ${leadDetails.id}.`,
            lead_id: leadDetails.id,
            hopper_id: hopperEntry.hopper_id,
            tracking_id: trackingId,
            // @ts-ignore
            twilio_call_sid: startCallResponse.call_sid
        });
      } else {
        callInitiationError = true;
        // @ts-ignore
        console.error(`Failed to initiate call via start.ts for lead ${leadDetails.id}. Status: ${startCallResult.statusCode}, Body: ${startCallResult.response.body}`);
      }
    } catch (e) {
      callInitiationError = true;
      // @ts-ignore
      console.error(`Critical error invoking start.ts for lead ${leadDetails.id}: ${e.message}`, e);
    }

    if (callInitiationError) {
      // Update hopper status to reflect error, possibly for retry or manual review
      // Consider an attempt counter on the hopper table as well
      await dbQuery("UPDATE hopper SET status = 'ERROR_INITIATING_CALL', updated_at = NOW() WHERE id = $1", [hopperEntry.hopper_id]);
      response.setStatusCode(500); // Or a more specific error if available
      response.setBody({
          success: false,
          status: 'error_initiating_call',
          message: `Failed to initiate call for lead ID ${leadDetails.id}.`,
          lead_id: leadDetails.id,
          hopper_id: hopperEntry.hopper_id
      });
    }

    return callback(null, response);

  } catch (error) {
    // @ts-ignore
    console.error('Unhandled error in Initial Dialer Service:', error.message, error.stack);

    // If we had a lock on a hopper entry but failed before updating its status or after a failed call initiation,
    // it's crucial to try and set it to an error state to prevent it from being stuck in 'PROCESSING_INITIAL_CALL'.
    if (hopperEntry && hopperEntry.hopper_id) {
      try {
        await dbQuery("UPDATE hopper SET status = 'ERROR_PROCESSING_UNHANDLED', updated_at = NOW() WHERE id = $1 AND status = 'PROCESSING_INITIAL_CALL'", [hopperEntry.hopper_id]);
        console.log(`Marked hopper entry ${hopperEntry.hopper_id} as ERROR_PROCESSING_UNHANDLED due to unhandled exception.`);
      } catch (dbUpdateError) {
        // @ts-ignore
        console.error(`Failed to update hopper entry ${hopperEntry.hopper_id} status on unhandled error: ${dbUpdateError.message}`);
      }
    }

    response.setStatusCode(500);
    response.setBody({ success: false, status: 'internal_server_error', message: `An unexpected error occurred: ${ (error instanceof Error) ? error.message : String(error)}` });
    return callback(null, response);
  }
};
