/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  base64url,
  JWSHeaderParameters,
  generateSecret,
  SignJWT,
  jwtVerify,
  exportJWK,
} from 'jose';
import { Config } from '@backstage/config';
import { AuthenticationError } from '@backstage/errors';
import { TokenManager } from './types';
import { Logger } from 'winston';

class NoopTokenManager implements TokenManager {
  public readonly isInsecureServerTokenManager: boolean = true;

  async getToken() {
    return { token: '' };
  }

  async authenticate() {}
}

/**
 * Creates and validates tokens for use during backend-to-backend
 * authentication.
 *
 * @public
 */
export class ServerTokenManager implements TokenManager {
  private verificationKeys: Uint8Array[];
  private signingKey: Uint8Array;

  static noop(): TokenManager {
    return new NoopTokenManager();
  }

  static fromConfig(config: Config, options: { logger: Logger }) {
    const { logger } = options;

    const keys = config.getOptionalConfigArray('backend.auth.keys');
    if (keys?.length) {
      return new ServerTokenManager(keys.map(key => key.getString('secret')));
    }
    if (process.env.NODE_ENV !== 'development') {
      throw new Error(
        'You must configure at least one key in backend.auth.keys for production.',
      );
    }
    // For development, if a secret has not been configured, we auto generate a secret instead of throwing.
    logger.warn(
      'Generated a secret for backend-to-backend authentication: DEVELOPMENT USE ONLY.',
    );
    return new ServerTokenManager([]);
  }

  private constructor(secrets: string[]) {
    if (!secrets.length && process.env.NODE_ENV !== 'development') {
      throw new Error(
        'No secrets provided when constructing ServerTokenManager',
      );
    }
    this.verificationKeys = new Array<Uint8Array>();
    secrets.map(k => this.verificationKeys.push(base64url.decode(k)));
    this.signingKey = this.verificationKeys[0];
  }

  // Called when no keys have been generated yet in the dev environment
  private async generateKeys(): Promise<void> {
    if (process.env.NODE_ENV !== 'development') {
      throw new Error(
        'Key generation is not supported outside of the dev environment',
      );
    }
    const secret = await generateSecret('HS256');
    const jwk = await exportJWK(secret);
    this.verificationKeys.push(base64url.decode(jwk.k ?? ''));
    this.signingKey = this.verificationKeys[0];
  }

  async getToken(): Promise<{ token: string }> {
    if (!this.verificationKeys.length) {
      await this.generateKeys();
    }
    const sub = 'backstage-server';
    const jwt = await new SignJWT({ alg: 'HS256' })
      .setProtectedHeader({ alg: 'HS256', sub: sub })
      .setSubject('backstage-server')
      .sign(this.signingKey);
    return { token: jwt };
  }

  async authenticate(token: string): Promise<void> {
    let verifyError = undefined;
    for (const key of this.verificationKeys) {
      const lookup = (_protectedHeader: JWSHeaderParameters): Uint8Array => {
        return key;
      };
      try {
        await jwtVerify(token, lookup);
        // If the verify succeeded, return
        return;
      } catch (e) {
        // Catch the verify exception and continue
        verifyError = e;
      }
    }
    throw new AuthenticationError(`Invalid server token: ${verifyError}`);
  }
}
