declare module '*.jsx' {
  import type { ReactElement } from 'react';
  const Component: () => ReactElement;
  export default Component;
}
