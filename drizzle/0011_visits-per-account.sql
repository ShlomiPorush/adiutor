ALTER TABLE "visits" DROP CONSTRAINT "visits_device_id_devices_id_fk";
--> statement-breakpoint
DROP INDEX "visits_device_at_idx";--> statement-breakpoint
CREATE INDEX "visits_at_idx" ON "visits" USING btree ("at");--> statement-breakpoint
ALTER TABLE "visits" DROP COLUMN "device_id";