export const TICKET_CATEGORIES = ['container', 'disk', 'network', 'domain', 'billing', 'account', 'other'] as const;
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export const TICKET_STATUSES = ['OPEN', 'REPLIED', 'CLOSED'] as const;
export type TicketCategory = typeof TICKET_CATEGORIES[number];
export type TicketPriority = typeof TICKET_PRIORITIES[number];
export type TicketStatus = typeof TICKET_STATUSES[number];
export const TICKET_MAX_FILES = 5;
export const TICKET_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const TICKET_FILE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.txt': 'text/plain', '.log': 'text/plain', '.out': 'text/plain', '.json': 'application/json',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain',
  '.cfg': 'text/plain', '.env': 'text/plain', '.xml': 'application/xml', '.properties': 'text/plain',
  '.sh': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.pdf': 'application/pdf', '.ofd': 'application/ofd',
};
// 编号直接由唯一、自增的 ID 派生，避免并发提交时争抢号码。
export const ticketNumber = (id: number) => id + 10000;
