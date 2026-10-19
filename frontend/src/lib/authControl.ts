export type UserRole = 'spectator' | 'master' | 'pending';

export type AuthState = {
  hasMaster: boolean;
  masterName: string;
  spectatorCount: number;
  maxSpectators: number;
  isSimRunning: boolean;
  scenario?: string;
};

export type AuthResponse = {
  type: 'ok' | 'error' | 'unauthorized';
  role?: UserRole;
  masterName?: string;
  reason?: string;
};

export function parseAuthStateMessage(message: string): AuthState | null {
  const prefix = 'auth:state?';
  if (!message.startsWith(prefix)) {
    return null;
  }

  const searchParams = new URLSearchParams(message.slice(prefix.length));
  const hasMasterVal = searchParams.get('hasMaster');
  const masterName = searchParams.get('masterName') ?? '';
  const spectatorCountVal = searchParams.get('spectatorCount');
  const maxSpectatorsVal = searchParams.get('maxSpectators');
  const isSimRunningVal = searchParams.get('isSimRunning');
  const scenarioVal = searchParams.get('scenario');

  if (hasMasterVal === null || spectatorCountVal === null) {
    return null;
  }

  return {
    hasMaster: hasMasterVal === '1' || hasMasterVal === 'true',
    masterName: decodeURIComponent(masterName),
    spectatorCount: Math.max(0, parseInt(spectatorCountVal, 10) || 0),
    maxSpectators: Math.max(1, parseInt(maxSpectatorsVal || '6', 10)),
    isSimRunning: isSimRunningVal === '1' || isSimRunningVal === 'true',
    scenario: scenarioVal ? decodeURIComponent(scenarioVal) : undefined
  };
}

export function parseAuthResponseMessage(message: string): AuthResponse | null {
  if (message.startsWith('auth:ok?')) {
    const params = new URLSearchParams(message.slice('auth:ok?'.length));
    const role = (params.get('role') as UserRole) || 'spectator';
    const masterName = params.get('masterName') ? decodeURIComponent(params.get('masterName')!) : undefined;
    return { type: 'ok', role, masterName };
  }

  if (message.startsWith('auth:error?')) {
    const params = new URLSearchParams(message.slice('auth:error?'.length));
    const reason = params.get('reason') ? decodeURIComponent(params.get('reason')!) : 'Unknown error';
    return { type: 'error', reason };
  }

  if (message.startsWith('auth:unauthorized?')) {
    const params = new URLSearchParams(message.slice('auth:unauthorized?'.length));
    const reason = params.get('reason')
      ? decodeURIComponent(params.get('reason')!)
      : 'Only the Master can control the simulation';
    return { type: 'unauthorized', reason };
  }

  return null;
}

export function formatMasterLoginMessage(password: string, name: string): string {
  const trimmedName = name.trim() || 'Master';
  return `auth:login?password=${encodeURIComponent(password)}&name=${encodeURIComponent(trimmedName)}`;
}

export function formatMasterLogoutMessage(): string {
  return 'auth:logout';
}

