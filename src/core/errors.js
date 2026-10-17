/** An error whose message is safe to show to the user, sent with the given HTTP status. */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
