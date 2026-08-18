import { AuthService } from '../application/auth-service';
import { PrismaAuthRepository } from '../infrastructure/persistence/prisma-auth-repository';

async function main() {
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const email = process.env.ADMIN_EMAIL ?? 'admin@netvision.local';
  const name = process.env.ADMIN_NAME ?? 'Administrador';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    console.error('Defina ADMIN_PASSWORD para criar/atualizar o administrador.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('ADMIN_PASSWORD deve ter pelo menos 8 caracteres.');
    process.exit(1);
  }

  const repository = new PrismaAuthRepository();
  const passwordHash = await AuthService.hashPassword(password);
  await repository.createAdmin({ username, email, name, passwordHash });
  await repository.disconnect();
  console.log(`Usuário administrador "${username}" criado/atualizado com sucesso.`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
