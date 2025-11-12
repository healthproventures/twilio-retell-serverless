// Cadence Rules New Type Definitions

export interface CadenceRuleDelay {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export interface CadenceRuleSegment {
  callCountMin: number;      // Inclusive minimum overall attemptCount for this segment to apply
  callCountMax: number;      // Inclusive maximum overall attemptCount for this segment to apply
                             // When processing outcome of attempt N, contact.attemptCount is N.
                             // This segment applies if N is within callCountMin/Max.
  delay: CadenceRuleDelay;   // The delay to apply *after* a call in this segment, for scheduling the *next* call.
  hopperPriorityOverride?: number;
}

export interface CadenceDispositionRule {
  segments: CadenceRuleSegment[];
  defaultHopperPriority?: number;
  finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED' | 'PAUSED' | 'COMPLETED_SUCCESS' | 'ERROR'; // Ensure all relevant final states are here
}

export interface CadenceRulesConfig {
  [disposition: string]: CadenceDispositionRule;
  DEFAULT: CadenceDispositionRule;
  NEW_LEAD: CadenceDispositionRule; // Rule for a contact before any call attempts (contact.attemptCount === 0)
  // Specific terminal dispositions can be defined here too
  APPOINTMENT_SCHEDULED_AI?: CadenceDispositionRule;
  CALL_COMPLETED_HUMAN_HANDOFF?: CadenceDispositionRule;
}

// Helper to convert simple minutes to CadenceRuleDelay
function minutesDelay(minutes: number): CadenceRuleDelay {
  return { days: 0, hours: 0, minutes, seconds: 0 };
}

// Updated Cadence Rules Configuration
export function getCadenceRules(): CadenceRulesConfig {
  return {
    NEW_LEAD: { // Rule for a new lead (contact.attemptCount === 0 when engine evaluates it)
      segments: [
        // This segment applies when the engine is about to make the 1st call.
        // The delay here is for *after* the 1st call, if its disposition maps back to NEW_LEAD (unlikely)
        // or if this rule is used as a generic "initial attempts" sequence.
        // More practically, NEW_LEAD in engine means "call now". Webhook uses outcome disposition.
        // For webhook: if outcome is e.g. NO_ANSWER, and attemptCount becomes 1, it uses NO_ANSWER rule, segment matching attemptCount 1.
        { callCountMin: 0, callCountMax: 0, delay: { days: 0, hours: 0, minutes: 0, seconds: 0 } }
      ],
      defaultHopperPriority: 100,
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED', // Should not be reached if segments are for attempt 0 only
    },
    ANSWERING_MACHINE: { // Based on user's "A - Answering Machine"
      defaultHopperPriority: 50, // Example default for this disposition
      segments: [
        // User: A - Answering Machine,0,1,0,0,22,4,None -> after 1st call (attemptCount becomes 1)
        { callCountMin: 1, callCountMax: 1, delay: { days: 0, hours: 0, minutes: 22, seconds: 4 } },
        // User: A - Answering Machine,2,2,0,0,11,52,None -> after 2nd call
        { callCountMin: 2, callCountMax: 2, delay: { days: 0, hours: 0, minutes: 11, seconds: 52 } },
        // User: A - Answering Machine,3,3,0,0,22,4,None -> after 3rd call
        { callCountMin: 3, callCountMax: 3, delay: { days: 0, hours: 0, minutes: 22, seconds: 4 } },
        // User: A - Answering Machine,4,4,0,0,11,52,None -> after 4th call
        { callCountMin: 4, callCountMax: 4, delay: { days: 0, hours: 0, minutes: 11, seconds: 52 } },
        // User: A - Answering Machine,5,5,0,1,30,32,None -> after 5th call
        { callCountMin: 5, callCountMax: 5, delay: { days: 0, hours: 1, minutes: 30, seconds: 32 } },
        // User: A - Answering Machine,6,6,0,0,22,4,None -> after 6th call
        { callCountMin: 6, callCountMax: 6, delay: { days: 0, hours: 0, minutes: 22, seconds: 4 } },
        // User: A - Answering Machine,7,7,0,1,30,32,None -> after 7th call
        { callCountMin: 7, callCountMax: 7, delay: { days: 0, hours: 1, minutes: 30, seconds: 32 } },
        // User: A - Answering Machine,8,8,0,0,11,52,None -> after 8th call
        { callCountMin: 8, callCountMax: 8, delay: { days: 0, hours: 0, minutes: 11, seconds: 52 } },
        // User: A - Answering Machine,9,9,0,1,30,32,None -> after 9th call
        { callCountMin: 9, callCountMax: 9, delay: { days: 0, hours: 1, minutes: 30, seconds: 32 } },
        // User: A - Answering Machine,10,10,0,0,22,4,None -> after 10th call
        { callCountMin: 10, callCountMax: 10, delay: { days: 0, hours: 0, minutes: 22, seconds: 4 } },
        // After 10 attempts with ANSWERING_MACHINE, this rule will lead to finalStatusOnExhaustion
        // if attemptCount becomes 11 and still ANSWERING_MACHINE.
      ],
      finalStatusOnExhaustion: 'PAUSED', // Example: pause after exhausting answering machine attempts
    },
    NO_ANSWER: {
      segments: [
        { callCountMin: 1, callCountMax: 1, delay: minutesDelay(20) },  // After 1st NO_ANSWER
        { callCountMin: 2, callCountMax: 2, delay: minutesDelay(120) }, // After 2nd NO_ANSWER
        { callCountMin: 3, callCountMax: 3, delay: { days: 1, hours: 0, minutes: 0, seconds: 0 } } // After 3rd
      ],
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED',
    },
    VOICEMAIL_DETECTED: { // This might be same as ANSWERING_MACHINE or different
      segments: [
        { callCountMin: 1, callCountMax: 1, delay: { days: 2, hours: 0, minutes: 0, seconds: 0 } },
        { callCountMin: 2, callCountMax: 2, delay: { days: 5, hours: 0, minutes: 0, seconds: 0 } },
      ],
      defaultHopperPriority: 40,
      finalStatusOnExhaustion: 'PAUSED',
    },
    BUSY: {
      segments: [
        { callCountMin: 1, callCountMax: 1, delay: minutesDelay(15) },
        { callCountMin: 2, callCountMax: 2, delay: minutesDelay(60) },
      ],
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED',
    },
    ERROR_CALL_FAILED: { // For technical errors reported by Retell/Twilio during the call
      segments: [
        { callCountMin: 1, callCountMax: 2, delay: minutesDelay(5) }, // Quick retry for first 2 failures
        { callCountMin: 3, callCountMax: 3, delay: minutesDelay(30) },// Longer retry for 3rd
      ],
      finalStatusOnExhaustion: 'ERROR',
    },
    ERROR_INITIATION_FAILED: { // Custom disposition if cadence engine fails to even start a call
        segments: [
            { callCountMin: 1, callCountMax: 3, delay: minutesDelay(10) }, // Retry initiation few times
        ],
        finalStatusOnExhaustion: 'ERROR',
    },
    APPOINTMENT_SCHEDULED_AI: { // Terminal success
        segments: [
            // No delay needed as it's terminal. Segment defines what happens if this state is re-evaluated (it shouldn't be).
            { callCountMin: 1, callCountMax: 99, delay: minutesDelay(0) }
        ],
        finalStatusOnExhaustion: 'COMPLETED_SUCCESS',
    },
    CALL_COMPLETED_HUMAN_HANDOFF: { // Terminal, pending further action outside automated cadence
        segments: [ { callCountMin: 1, callCountMax: 99, delay: minutesDelay(0) } ],
        finalStatusOnExhaustion: 'PAUSED',
    },
    DEFAULT: { // Fallback for any other disposition
      segments: [
        // Applies if attemptCount is 1 (after 1st call with unknown disposition)
        { callCountMin: 1, callCountMax: 1, delay: minutesDelay(5) },
      ],
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED', // Or 'PAUSED' for review
    },
  };
}
