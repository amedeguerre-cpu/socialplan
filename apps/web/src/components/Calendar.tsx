/** Faz 6'da haftalık takvim; şimdilik liste görünümüne yönlendirir. */
import { PostList } from './PostList';

export function CalendarView({ onOpen }: { onOpen: (id: string) => void }) {
  return <PostList onOpen={onOpen} />;
}
