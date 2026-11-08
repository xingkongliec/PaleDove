// 工单（用户与管理员共用）：/console/tickets 列表、/console/tickets/new 提交、/console/tickets/:id 详情；管理员为 /admin/tickets
import { useParams } from 'react-router';
import { TicketCreate } from './TicketCreate';
import { TicketDetail } from './TicketDetail';
import { TicketList } from './TicketList';

export default function TicketsPage({ admin = false, create = false }: { admin?: boolean; create?: boolean }) {
  const { id } = useParams();
  if (id) return <TicketDetail key={`${admin}-${id}`} admin={admin} id={id} />;
  if (create) return <TicketCreate />;
  return <TicketList key={String(admin)} admin={admin} />;
}
