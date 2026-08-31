import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3001),
  CORS_ORIGIN: Joi.string().uri().default('http://localhost:4200'),
  DATABASE_URL: Joi.string().required(),
  ROOT_WORK_EMAIL: Joi.string().email().default('root@company.example'),
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_S3_BUCKET: Joi.string().default('user-management-photos'),
  // Set for LocalStack (local dev/CI); unset in prod to use real AWS endpoints.
  AWS_ENDPOINT_URL: Joi.string().uri().optional(),
  AWS_ACCESS_KEY_ID: Joi.string().default('test'),
  AWS_SECRET_ACCESS_KEY: Joi.string().default('test'),

  // Magic-link email delivery (Epic 2). APP_BASE_URL is the frontend origin
  // the sign-in link points back to. SMTP_* are a plain nodemailer transport
  // config — point them at whatever SMTP relay the machine can reach. With
  // SMTP_HOST unset, or NODE_ENV=test, the mailer logs the link to the
  // server console instead of opening a connection (see NodemailerMagicLinkMailer).
  APP_BASE_URL: Joi.string().uri().default('http://localhost:4200'),
  SMTP_HOST: Joi.string().optional(),
  SMTP_PORT: Joi.number().port().default(587),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().optional(),
  SMTP_PASSWORD: Joi.string().optional(),
  SMTP_FROM: Joi.string().default('People Platform <no-reply@people.local>'),
});
