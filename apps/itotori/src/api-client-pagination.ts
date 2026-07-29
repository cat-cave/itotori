import type { CostDrilldownPagination } from "@itotori/db";
import { ItotoriApiClient } from "./api-client-core.js";
import type {
  ApiClientError,
  ApiRequestOptionsFor,
  ApiRouteResponse,
  ItotoriApiRouteId,
} from "./api-client-types.js";

export type OffsetCursor = {
  offset: number;
  limit: number;
};

export type OffsetPaginatedRouteId = {
  [R in ItotoriApiRouteId]: ApiRouteResponse<R> extends { pagination: CostDrilldownPagination }
    ? R
    : never;
}[ItotoriApiRouteId];

export type OffsetPagerOptions<R extends OffsetPaginatedRouteId> = Omit<
  ApiRequestOptionsFor<R>,
  "isEmpty"
> & {
  limit: number;
  initialOffset?: number;
};

export type OffsetPagerResult<R extends OffsetPaginatedRouteId> =
  | { state: "ready"; data: ApiRouteResponse<R>; cursor: OffsetCursor; hasNext: boolean }
  | { state: "empty" }
  | { state: "error"; error: ApiClientError };

export class OffsetPager<R extends OffsetPaginatedRouteId> {
  private readonly client: ItotoriApiClient;
  private readonly routeId: R;
  private readonly limit: number;
  private readonly options: OffsetPagerOptions<R>;
  private nextOffset: number | null;
  private lastCursor: OffsetCursor | null = null;

  constructor(client: ItotoriApiClient, routeId: R, options: OffsetPagerOptions<R>) {
    this.client = client;
    this.routeId = routeId;
    this.limit = options.limit;
    this.options = options;
    this.nextOffset = options.initialOffset ?? 0;
  }

  get hasNext(): boolean {
    return this.nextOffset !== null;
  }

  get lastPageCursor(): OffsetCursor | null {
    return this.lastCursor;
  }

  async next(): Promise<OffsetPagerResult<R>> {
    const offset = this.nextOffset;
    if (offset === null) {
      return { state: "empty" };
    }
    this.lastCursor = { offset, limit: this.limit };
    const result = await this.client.request<R>(this.routeId, this.buildOptions(offset));
    if (result.state === "ready") {
      const pagination = result.data.pagination;
      this.nextOffset = pagination.nextOffset;
      return {
        state: "ready",
        data: result.data,
        cursor: { offset, limit: this.limit },
        hasNext: pagination.nextOffset !== null,
      };
    }
    if (result.state === "error") {
      this.nextOffset = offset;
    }
    return result;
  }

  private buildOptions(offset: number): ApiRequestOptionsFor<R> {
    const base = this.options as Partial<ApiRequestOptionsFor<R>> & {
      query?: Readonly<Record<string, string | number | boolean | null>>;
    };
    const query: Record<string, string | number | boolean | null> = {
      ...base.query,
      limit: this.limit,
      offset,
    };
    return { ...base, query, isEmpty: () => false } as unknown as ApiRequestOptionsFor<R>;
  }
}
