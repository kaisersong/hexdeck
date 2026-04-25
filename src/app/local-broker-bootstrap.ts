export function nextLocalBrokerBootstrapAttempt(
  lastAttemptToken: string | null,
  brokerUrl: string,
  reloadKey: number,
  defaultBrokerUrl: string
): string | null {
  if (brokerUrl !== defaultBrokerUrl) {
    return null;
  }

  const nextToken = `${brokerUrl}::${reloadKey}`;
  return nextToken === lastAttemptToken ? null : nextToken;
}
