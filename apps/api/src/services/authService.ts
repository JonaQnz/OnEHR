import axios from 'axios';
import { getConfig } from './configService';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

const toFormUrlEncoded = (details: Record<string, string>) => {
  return Object.keys(details)
    .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(details[key]))
    .join('&');
};

export async function getValidToken(): Promise<string> {
    const config = getConfig();
    if (config.authMode !== 'keycloak') {
        throw new Error('Auth mode is not keycloak');
    }

    // Return cached token if valid (buffer of 10 seconds)
    if (cachedToken && Date.now() < tokenExpiresAt - 10000) {
        return cachedToken;
    }

    const { keycloakApi, keycloakTenantName, keycloakClientId, keycloakGrantType, ehrbaseUser, ehrbasePass } = config;

    if (!keycloakApi || !keycloakTenantName || !keycloakClientId) {
        throw new Error('Missing Keycloak configuration');
    }

    const tokenUrl = `${keycloakApi}/auth/realms/${keycloakTenantName}/protocol/openid-connect/token`;

    const payload: Record<string, string> = {
        grant_type: keycloakGrantType || 'password',
        client_id: keycloakClientId
    };

    if (payload.grant_type === 'password') {
        payload.username = ehrbaseUser || '';
        payload.password = ehrbasePass || '';
    }

    console.log(`Requesting Keycloak token for ${payload.username || payload.client_id} from ${tokenUrl}`);

    try {
        const response = await axios.post(tokenUrl, toFormUrlEncoded(payload), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        cachedToken = response.data.access_token;
        const expiresIn = response.data.expires_in || 300; // default 5 minutes
        tokenExpiresAt = Date.now() + (expiresIn * 1000);

        console.log('Successfully acquired Keycloak token');
        return cachedToken!;
    } catch (error: any) {
        console.error('Failed to fetch Keycloak token:', error.response?.data || error.message);
        throw new Error('Failed to fetch Keycloak token');
    }
}
