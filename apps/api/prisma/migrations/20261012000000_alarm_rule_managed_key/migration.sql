-- F9.6: identidade das regras gerenciadas pela aba BASICO (uma por slot).
-- Regras custom continuam com managedKey NULL.
ALTER TABLE "AlarmRule" ADD COLUMN "managedKey" TEXT;

CREATE UNIQUE INDEX "AlarmRule_managedKey_key" ON "AlarmRule"("managedKey");
