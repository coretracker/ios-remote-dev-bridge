async function postSlackMessage(botToken, payload) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    throw new Error(`Slack API request failed (${response.status}): ${responseText || response.statusText}`);
  }

  const responseJson = await response.json().catch(() => null);
  if (!responseJson || responseJson.ok !== true) {
    const apiError = responseJson && responseJson.error ? responseJson.error : 'unknown_error';
    throw new Error(`Slack API error: ${apiError}`);
  }
}

function buildIpaSlackPayload(input) {
  const app = input.app || 'unknown';
  const version = input.version || 'unknown';
  const build = input.build || 'unknown';
  const summary = input.summary || 'No summary provided.';
  const channelLine = input.channel ? `Channel: ${input.channel}` : null;
  const ipaNames = input.ipaNames && input.ipaNames.length ? input.ipaNames.join(', ') : 'unknown';

  const lines = [
    ':package: New IPA uploaded',
    `App: ${app}`,
    `Version: ${version}`,
    `Build: ${build}`,
    `Summary: ${summary}`,
    `IPA: ${ipaNames}`,
    channelLine
  ].filter(Boolean);

  return {
    text: lines.join('\n'),
    ...(input.channel ? { channel: input.channel } : {})
  };
}

module.exports = {
  buildIpaSlackPayload,
  postSlackMessage
};
