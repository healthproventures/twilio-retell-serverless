export interface ContactCadenceState {
  phoneNumber: string; // Primary key, E.164 format
  leadId?: string;
  lastCallSid?: string;
  lastCallDisposition?: string;
  lastAttemptTimestamp?: string; // ISO 8601 string
  nextCallTimestamp?: string;    // ISO 8601 string
  attemptCount: number;
  status: 'PENDING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED_SUCCESS' | 'COMPLETED_EXHAUSTED' | 'ERROR';
  metadata?: { [key: string]: any };
  currentCallSid?: string; // SID of the call currently being attempted for this contact
  // New fields for prioritization
  state?: string;       // For US state
  zipcode?: string;
  hopperPriority?: number;
}
