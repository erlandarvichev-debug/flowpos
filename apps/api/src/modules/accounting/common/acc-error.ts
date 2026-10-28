import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Понятная ошибка учёта: что произошло, что исправить, куда перейти.
 * Клиент получает { code, message, fix, link, details }.
 */
export class AccError extends HttpException {
  constructor(
    code: string,
    message: string,
    opts: { fix?: string; link?: string; details?: any; status?: HttpStatus } = {},
  ) {
    super({ code, message, fix: opts.fix, link: opts.link, details: opts.details }, opts.status ?? HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
