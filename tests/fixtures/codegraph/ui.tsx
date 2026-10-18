import { helper } from './b';
export const Button = forwardRef(() => helper());
export function Page() {
  return <Button />;
}
