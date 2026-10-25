import { normalizeRoomCode } from '../../shared/validation';
import { ControllerPage } from './pages/ControllerPage';
import { DisplayPage } from './pages/DisplayPage';
import { HostPage } from './pages/HostPage';
import { Landing } from './pages/Landing';
import { usePath } from './lib/router';

export function App() {
  const path = usePath();
  const [, section, rawCode] = path.split('/');
  const code = normalizeRoomCode(rawCode ?? '') ?? null;

  switch (section) {
    case 'host':
      return <HostPage key="host" initialCode={code} />;
    case 'join':
      return <ControllerPage key={`join-${code ?? ''}`} initialCode={code} />;
    case 'display':
      return code ? <DisplayPage key={`display-${code}`} code={code} /> : <Landing />;
    default:
      return <Landing />;
  }
}
