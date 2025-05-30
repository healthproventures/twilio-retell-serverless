// Cadence Rules Types
export interface CadenceAttemptRule {
  delayMinutes: number; // Delay for this specific attempt after the previous one's outcome
}

export interface CadenceDispositionRule {
  maxAttempts: number; // Total attempts allowed *under this specific disposition track*
                       // This means if disposition changes, maxAttempts for new disposition applies.
  attempts: CadenceAttemptRule[]; // Ordered list of attempt delays.
                                  // Length should ideally match maxAttempts.
                                  // Index `i` is for the (i+1)-th attempt in this disposition sequence.
  finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED' | 'PAUSED' | 'ERROR'; // Status if max attempts for this disposition reached
  // Optional: Flag to indicate if this disposition should reset the attempt count for the overall lead,
  // or if a specific disposition sequence should use its own counter.
  // For now, we assume the main contactState.attemptCount is the primary counter.
}

export interface CadenceRulesConfig {
  [disposition: string]: CadenceDispositionRule;
  NEW_LEAD: CadenceDispositionRule; // Rule for contacts with no prior attempts (contact.attemptCount === 0)
  DEFAULT: CadenceDispositionRule;  // Fallback for unlisted dispositions
  // Specific terminal dispositions that should always complete the cadence
  APPOINTMENT_SCHEDULED_AI?: CadenceDispositionRule; // Example
  HUMAN_HANDOFF_SUCCESSFUL?: CadenceDispositionRule; // Example
  // Note: These specific terminal dispositions might not need full CadenceDispositionRule structure if they simply terminate.
  // However, using the structure allows for consistency. MaxAttempts could be 1.
}

// Hardcoded Cadence Rules Configuration
export function getCadenceRules(): CadenceRulesConfig {
  return {
    NEW_LEAD: { // For brand new leads (overall contact.attemptCount will be 0)
      maxAttempts: 5, // Total attempts for a new lead if it keeps getting non-terminal dispositions
      attempts: [
        // Delay for the 1st attempt is implicitly handled by how soon the engine picks it up.
        // The delays here are for *subsequent* attempts *if the disposition remains unchanged or maps to a retryable one*.
        // This rule might be better named e.g. "STANDARD_RETRY_SEQUENCE" if NEW_LEAD is just for the first call.
        // Let's assume NEW_LEAD implies the sequence for a lead that hasn't had a significant outcome yet.
        { delayMinutes: 0 },       // For 1st attempt (engine picks up, this '0' is conceptual for calculating next step after outcome)
        { delayMinutes: 60 },      // For 2nd attempt (1 hour after outcome of attempt 1)
        { delayMinutes: 24 * 60 }, // For 3rd attempt (1 day after outcome of attempt 2)
        { delayMinutes: 48 * 60 }, // For 4th attempt (2 days after outcome of attempt 3)
        { delayMinutes: 72 * 60 }, // For 5th attempt (3 days after outcome of attempt 4)
      ],
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED',
    },
    NO_ANSWER: { // If lastCallDisposition was NO_ANSWER
      maxAttempts: 3, // Max 3 consecutive NO_ANSWER before changing strategy or exhausting
      attempts: [
        { delayMinutes: 20 },  // After 1st NO_ANSWER, try again in 20 mins
        { delayMinutes: 120 }, // After 2nd NO_ANSWER, try again in 2 hours
        { delayMinutes: 24 * 60 },// After 3rd NO_ANSWER, try again in 1 day (if maxAttempts allows for a 4th)
      ],
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED',
    },
    VOICEMAIL_DETECTED: {
      maxAttempts: 2,
      attempts: [
        { delayMinutes: 2 * 24 * 60 }, // Try again in 2 days
        { delayMinutes: 5 * 24 * 60 }, // Then try again in 5 days
      ],
      finalStatusOnExhaustion: 'PAUSED', // Pause for manual review if voicemail hit twice
    },
    BUSY: {
      maxAttempts: 2,
      attempts: [
        { delayMinutes: 15 },
        { delayMinutes: 60 },
      ],
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED',
    },
    ERROR_CALL_FAILED: { // For technical errors during the call itself
      maxAttempts: 2,
      attempts: [
        { delayMinutes: 5 },  // Quick retry
        { delayMinutes: 30 }, // Longer retry
      ],
      finalStatusOnExhaustion: 'ERROR',
    },
    // Example of a specific terminal disposition
    APPOINTMENT_SCHEDULED_AI: {
        maxAttempts: 1, // This disposition means completion
        attempts: [{ delayMinutes: 0 }], // No further attempts
        finalStatusOnExhaustion: 'COMPLETED_SUCCESS',
    },
    CALL_COMPLETED_HUMAN_HANDOFF: { // Assuming this is a disposition from Retell
        maxAttempts: 1,
        attempts: [{ delayMinutes: 0 }],
        finalStatusOnExhaustion: 'PAUSED', // Or COMPLETED_SUCCESS depending on definition
    },
    DEFAULT: { // Fallback for any other disposition not explicitly listed
      maxAttempts: 1, 
      attempts: [
        { delayMinutes: 5 }, // Default quick retry once for an unknown disposition
      ],
      finalStatusOnExhaustion: 'COMPLETED_EXHAUSTED', // Or 'PAUSED' for review
    },
  };
}
