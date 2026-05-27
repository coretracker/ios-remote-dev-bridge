function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

module.exports = {
  logEvent
};
