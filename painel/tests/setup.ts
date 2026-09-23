// Os testes de consulta falam com o banco de verdade, então precisam das
// mesmas variáveis que o servidor usa. O Next carrega `.env.local`
// sozinho; o Vitest não.
import { config } from "dotenv";
config({ path: ".env.local" });
