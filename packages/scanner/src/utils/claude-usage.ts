let claudeCallsToday = 0;
let lastResetDate = '';

export function trackClaudeCall(context: string): void {
  const today = new Date().toISOString().split('T')[0];
  if (today !== lastResetDate) {
    claudeCallsToday = 0;
    lastResetDate = today;
  }
  claudeCallsToday++;
  console.log(`  [claude-cli] call #${claudeCallsToday} today (${context})`);
}

export function getClaudeUsage(): { today: number } {
  return { today: claudeCallsToday };
}
