export class CategoryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CategoryError";
  }
}

export class CategoryConflictError extends CategoryError {
  constructor(message: string) {
    super(message, 409);
    this.name = "CategoryConflictError";
  }
}
