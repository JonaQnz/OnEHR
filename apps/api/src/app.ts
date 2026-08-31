import express, { type Express } from 'express';
import cors from 'cors';
import formRoutes from './routes/formRoutes';
import templateRoutes from './routes/templateRoutes';
import configRoutes from './routes/configRoutes';
import { errorHandler } from './middleware/errorHandler';
import pluginRoutes from './routes/pluginRoutes';
import authRoutes from './routes/authRoutes';
import { attachAuth } from './middleware/auth';
import formSessionRoutes from './routes/formSessionRoutes';
import dataProviderRoutes from './routes/dataProviderRoutes';
import patientRoutes from './routes/patientRoutes';
import scriptConnectorRoutes from './routes/scriptConnectorRoutes';
import formLaunchRoutes from './routes/formLaunchRoutes';
import functionRoutes from './routes/functionRoutes';
import userAdminRoutes from './routes/userAdminRoutes';
import auditRoutes from './routes/auditRoutes';
import ehrbaseAdminRoutes from './routes/ehrbaseAdminRoutes';
import compositionSessionRoutes from './routes/compositionSessionRoutes';
import dataWidgetRoutes from './routes/dataWidgetRoutes';

/**
 * Pure Express app construction - every route, in the exact same order
 * index.ts always wired them in, with no side effects (no dotenv, no
 * initConfig, no plugin loading, no bootstrap admin, no .listen()). Split
 * out of index.ts so HTTP-layer tests (tests/http/*.test.js) can exercise
 * the real Express request/response cycle - routing, express.json() body
 * parsing, attachAuth/requirePermission, errorHandler - against an
 * in-process server, instead of only ever calling service functions
 * directly like every other existing test does. index.ts remains the only
 * place that actually starts a listening server / touches the real DB and
 * plugin registry at process startup.
 */
export function createApp(): Express {
  const app = express();
  app.use('/api', attachAuth);

  app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:3000', credentials: true }));
  app.use(express.json());

  // Incoming request logger middleware
  app.use((req, res, next) => {
    console.log(`\n📥 [API INCOMING] ${req.method} ${req.url}`);
    next();
  });

  app.use('/api/auth', authRoutes);
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.use('/api/form-sessions', formSessionRoutes);
  app.use('/api/composition-sessions', compositionSessionRoutes);
  app.use('/api/form-launches', formLaunchRoutes);
  app.use('/api/data-providers', dataProviderRoutes);
  app.use('/api/patients', patientRoutes);
  app.use('/api/script-connectors', scriptConnectorRoutes);
  app.use('/api/functions', functionRoutes);
  app.use('/api/widgets', dataWidgetRoutes);
  app.use('/api/admin', userAdminRoutes);
  app.use('/api/admin/audit', auditRoutes);
  app.use('/api/admin/ehrbase', ehrbaseAdminRoutes);

  app.use('/api/forms', formRoutes);
  app.use('/api/templates', templateRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/plugins', pluginRoutes);

  app.use(errorHandler);
  return app;
}
