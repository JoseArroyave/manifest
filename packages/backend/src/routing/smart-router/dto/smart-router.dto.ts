import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ModelRouteDto } from '../../dto/routing.dto';

export class UpdateSmartRouterDto {
  /** Master switch for the layer. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * The router model. `null` clears the configured router and turns the layer
   * off (there is nothing to ask without a model).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ModelRouteDto)
  model?: ModelRouteDto | null;

  /** Whether the router model is also offered as a candidate for itself. */
  @IsOptional()
  @IsBoolean()
  include_router_in_candidates?: boolean;
}
