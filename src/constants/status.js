export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
});

export const NOTIFICATION_STATUS = Object.freeze({
  SENT: 'sent',
  PARTIAL: 'partial',
  FAILED: 'failed',
  // Firebase is disabled: the notification was logged instead of sent.
  SIMULATED: 'simulated',
});
