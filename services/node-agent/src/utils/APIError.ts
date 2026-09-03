import { SwaggerContract } from "@/contracts/swagger";
import { I18n, I18nArgs, StatusCodes } from "@/types/shared";

/**
 * Ошибка API
 */
export class APIError extends Error {
  public name = "APIError";
  public statusCode!: StatusCodes;
  // `declare` and not a plain field: with target ES2022 this tsconfig leaves
  // useDefineForClassFields at its default (true), so a bare `message!: I18n`
  // is EMITTED as a class field. Class fields initialise after super(), which
  // means the declaration re-defined the property to undefined immediately
  // after Error's constructor had set it -- every APIError carried
  // `message: undefined`, and fastifyErrorHandler translated that into every
  // error body. `declare` narrows the inherited property's type and emits
  // nothing. statusCode and args are safe because the constructor body
  // assigns them, which runs after the field initialisers.
  declare public message: I18n;
  public args!: I18nArgs;

  constructor(
    statusCode: StatusCodes,
    { msg, args }: { msg?: I18n; args?: I18nArgs } = {},
  ) {
    super(msg || SwaggerContract.CodeDescriptions[statusCode]);

    this.statusCode = statusCode;
    this.args = args || {};
  }
}
