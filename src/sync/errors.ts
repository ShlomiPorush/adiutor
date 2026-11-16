// The sync's one failure type with a stable code. Its message is shown to the owner and never holds a token, a code
// or any other secret.

export class ClientError extends Error {
  override name = "ClientError"
  constructor(
    readonly code: string,
    message: string,
    readonly extra: { sent?: boolean; status?: number } = {},
  ) {
    super(message)
  }
}
