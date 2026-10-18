import { helper } from './b';
import { useU } from '@/lib/u';
export const Button = forwardRef(() => helper());
export function Page() {
  useU();
  return <Button />;
}
