import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Org, OrgContext, OrgGuard } from '../accounting/access/org-context';
import { SearchService } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('search')
export class SearchController {
  constructor(private search: SearchService) {}

  /** Поиск по системе: группы, на которые у роли нет прав, приходят пустыми. */
  @Get()
  find(@Org() ctx: OrgContext, @Query('q') q: string) { return this.search.search(ctx, q); }
}
