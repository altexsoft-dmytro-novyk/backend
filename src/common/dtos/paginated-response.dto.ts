// Shared response envelope for any paginated list endpoint — the actual
// page of results lives in `items`, alongside the metadata a caller needs
// to page through the rest.
export class PaginatedResponseDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;

  constructor(items: T[], total: number, page: number, pageSize: number) {
    this.items = items;
    this.total = total;
    this.page = page;
    this.pageSize = pageSize;
  }
}
