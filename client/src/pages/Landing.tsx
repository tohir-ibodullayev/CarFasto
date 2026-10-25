import { useState, type FormEvent } from 'react';
import { CODE_LENGTH } from '../../../shared/constants';
import { normalizeRoomCode } from '../../../shared/validation';
import { sfx } from '../lib/audio';
import { navigate } from '../lib/router';

export function Landing() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const join = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (!normalized) {
      setError(`Enter the ${CODE_LENGTH}-character code shown on the host screen.`);
      return;
    }
    navigate(`/join/${normalized}`);
  };

  return (
    <main className="landing">
      <div className="landing-card">
        <div className="logo">
          <span className="logo-blue">SPLIT</span> <span className="logo-orange">STEERING</span>
        </div>
        <p className="tagline">Two teams. Two cars. Four phones. Half the steering is yours.</p>
        <ul className="how">
          <li>
            <b>One laptop</b> shows two four-lane roads side by side.
          </li>
          <li>
            <b>Four phones</b> join by QR code: each team has a <b>LEFT</b> player and a <b>RIGHT</b> player.
          </li>
          <li>
            <b>Shake</b> your phone to move your team&apos;s car one lane in your direction. Shout. Coordinate.
          </li>
          <li>
            Both teams face the exact same traffic. <b>First team to crash loses.</b>
          </li>
        </ul>
        <div className="landing-actions">
          <button
            className="btn btn-primary btn-xl"
            onClick={() => {
              sfx.unlock();
              navigate('/host');
            }}
          >
            Host game
            <small>on the laptop / big screen</small>
          </button>
          <form className="join-form" onSubmit={join}>
            <label htmlFor="code">Join with a phone</label>
            <div className="join-row">
              <input
                id="code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setError(null);
                }}
                placeholder="ROOM CODE"
                maxLength={CODE_LENGTH + 2}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
              />
              <button className="btn btn-secondary" type="submit">
                Join game
              </button>
            </div>
            {error && <p className="error">{error}</p>}
          </form>
        </div>
      </div>
    </main>
  );
}
