/** Platform publisher'larını ve OAuth adaptörlerini kaydeder (yan etkili içe aktarma). */
import { registerOAuth } from '../oauth/registry';
import { instagramOAuth, instagramPublisher } from './instagram';
import { registerPublisher } from './registry';
import type { Publisher } from './types';

registerPublisher(instagramPublisher as unknown as Publisher);
registerOAuth(instagramOAuth);
