// Shared response envelope for any paginated list endpoint — the actual
// page of results lives in `items`, alongside the metadata a caller needs
// to page through the rest.
export class PaginatedResponseDto<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  // `Math.ceil(total / pageSize)`, and `0` when `total` is `0`.
  totalPages: number;

  constructor(items: T[], total: number, page: number, pageSize: number) {
    this.items = items;
    this.page = page;
    this.pageSize = pageSize;
    this.total = total;
    this.totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  }
}
