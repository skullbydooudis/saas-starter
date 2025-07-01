import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import readline from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const execAsync = promisify(exec);

function question(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

async function checkStripeCLI() {
  console.log(
    'Step 1: Checking if Stripe CLI is available...'
  );
  try {
    await execAsync('stripe --version');
    console.log('Stripe CLI is installed.');

    // Check if Stripe CLI is authenticated
    try {
      await execAsync('stripe config --list');
      console.log('Stripe CLI is authenticated.');
      return true;
    } catch (error) {
      console.log(
        'Stripe CLI is not authenticated or the authentication has expired.'
      );
      console.log('Please run: stripe login');
      const answer = await question(
        'Have you completed the authentication? (y/n): '
      );
      if (answer.toLowerCase() !== 'y') {
        console.log(
          'Continuing without Stripe CLI authentication. You can set up webhooks manually.'
        );
        return false;
      }

      // Verify authentication after user confirms login
      try {
        await execAsync('stripe config --list');
        console.log('Stripe CLI authentication confirmed.');
        return true;
      } catch (error) {
        console.error(
          'Failed to verify Stripe CLI authentication. Continuing without CLI.'
        );
        return false;
      }
    }
  } catch (error) {
    console.log(
      'Stripe CLI is not available in this environment. This is normal for WebContainer/browser environments.'
    );
    console.log('You can set up webhooks manually later if needed.');
    return false;
  }
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execAsync('docker --version');
    return true;
  } catch (error) {
    return false;
  }
}

async function getPostgresURL(): Promise<string> {
  console.log('Step 2: Setting up Postgres');
  
  const dockerAvailable = await isDockerAvailable();
  
  if (!dockerAvailable) {
    console.log('Docker is not available in this environment (WebContainer/browser).');
    console.log('For database options in this environment, you can use:');
    console.log('1. Remote Postgres database (recommended)');
    console.log('2. SQLite (for development/testing)');
    console.log('');
    console.log('Popular remote Postgres providers:');
    console.log('- Supabase: https://supabase.com/');
    console.log('- Neon: https://neon.tech/');
    console.log('- Vercel Postgres: https://vercel.com/storage/postgres');
    console.log('- Railway: https://railway.app/');
    console.log('');
    
    const dbChoice = await question(
      'Do you want to use a remote Postgres instance (R) or SQLite for development (S)? (R/S): '
    );
    
    if (dbChoice.toLowerCase() === 's') {
      console.log('Using SQLite for development...');
      return 'file:./dev.db';
    } else {
      return await question('Enter your POSTGRES_URL: ');
    }
  }
  
  const dbChoice = await question(
    'Do you want to use a local Postgres instance with Docker (L) or a remote Postgres instance (R)? (L/R): '
  );

  if (dbChoice.toLowerCase() === 'l') {
    console.log('Setting up local Postgres instance with Docker...');
    await setupLocalPostgres();
    return 'postgres://postgres:postgres@localhost:54322/postgres';
  } else {
    console.log(
      'You can find Postgres databases at: https://vercel.com/marketplace?category=databases'
    );
    return await question('Enter your POSTGRES_URL: ');
  }
}

async function setupLocalPostgres() {
  console.log('Creating docker-compose.yml file...');
  const dockerComposeContent = `
services:
  postgres:
    image: postgres:16.4-alpine
    container_name: next_saas_starter_postgres
    environment:
      POSTGRES_DB: postgres
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "54322:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
`;

  await fs.writeFile(
    path.join(process.cwd(), 'docker-compose.yml'),
    dockerComposeContent
  );
  console.log('docker-compose.yml file created.');

  console.log('Starting Docker container with `docker compose up -d`...');
  try {
    await execAsync('docker compose up -d');
    console.log('Docker container started successfully.');
  } catch (error) {
    console.error(
      'Failed to start Docker container. Please check your Docker installation and try again.'
    );
    process.exit(1);
  }
}

async function getStripeSecretKey(): Promise<string> {
  console.log('Step 3: Getting Stripe Secret Key');
  console.log(
    'You can find your Stripe Secret Key at: https://dashboard.stripe.com/test/apikeys'
  );
  return await question('Enter your Stripe Secret Key: ');
}

async function createStripeWebhook(hasStripeCLI: boolean): Promise<string> {
  if (hasStripeCLI) {
    console.log('Step 4: Creating Stripe webhook with CLI...');
    try {
      const { stdout } = await execAsync('stripe listen --print-secret');
      const match = stdout.match(/whsec_[a-zA-Z0-9]+/);
      if (!match) {
        throw new Error('Failed to extract Stripe webhook secret');
      }
      console.log('Stripe webhook created.');
      return match[0];
    } catch (error) {
      console.error(
        'Failed to create Stripe webhook with CLI. Falling back to manual setup.'
      );
      return await getManualWebhookSecret();
    }
  } else {
    return await getManualWebhookSecret();
  }
}

async function getManualWebhookSecret(): Promise<string> {
  console.log('Step 4: Manual Stripe webhook setup');
  console.log('Since Stripe CLI is not available, you can set up webhooks manually:');
  console.log('1. Go to https://dashboard.stripe.com/test/webhooks');
  console.log('2. Click "Add endpoint"');
  console.log('3. Set the endpoint URL to: http://localhost:3000/api/stripe/webhook');
  console.log('4. Select the events you want to listen for (e.g., checkout.session.completed)');
  console.log('5. Click "Add endpoint"');
  console.log('6. Copy the webhook signing secret (starts with whsec_)');
  console.log('');
  
  const useWebhook = await question('Do you want to set up a webhook secret now? (y/n): ');
  
  if (useWebhook.toLowerCase() === 'y') {
    return await question('Enter your Stripe Webhook Secret (whsec_...): ');
  } else {
    console.log('Skipping webhook setup. You can add STRIPE_WEBHOOK_SECRET to your .env file later.');
    return 'your_webhook_secret_here';
  }
}

function generateAuthSecret(): string {
  console.log('Step 5: Generating AUTH_SECRET...');
  return crypto.randomBytes(32).toString('hex');
}

async function writeEnvFile(envVars: Record<string, string>) {
  console.log('Step 6: Writing environment variables to .env');
  const envContent = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  await fs.writeFile(path.join(process.cwd(), '.env'), envContent);
  console.log('.env file created with the necessary variables.');
}

async function main() {
  const hasStripeCLI = await checkStripeCLI();

  const POSTGRES_URL = await getPostgresURL();
  const STRIPE_SECRET_KEY = await getStripeSecretKey();
  const STRIPE_WEBHOOK_SECRET = await createStripeWebhook(hasStripeCLI);
  const BASE_URL = 'http://localhost:3000';
  const AUTH_SECRET = generateAuthSecret();

  await writeEnvFile({
    POSTGRES_URL,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    BASE_URL,
    AUTH_SECRET,
  });

  console.log('🎉 Setup completed successfully!');
  
  if (!hasStripeCLI && STRIPE_WEBHOOK_SECRET === 'your_webhook_secret_here') {
    console.log('');
    console.log('⚠️  Remember to update your STRIPE_WEBHOOK_SECRET in the .env file');
    console.log('   after setting up your webhook endpoint in the Stripe dashboard.');
  }
  
  if (POSTGRES_URL === 'file:./dev.db') {
    console.log('');
    console.log('📝 Note: You are using SQLite for development.');
    console.log('   For production, consider using a remote Postgres database.');
  }
}

main().catch(console.error);