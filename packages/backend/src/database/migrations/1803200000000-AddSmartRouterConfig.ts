import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Smart Router's configuration and audit columns.
 *
 * `agents` gains the router's identity (provider / model / auth type / key
 * label), the master switch and the "include the router in the candidate list"
 * toggle. The switch defaults to false, so every existing install keeps
 * today's routing byte-for-byte until an operator opts in.
 *
 * `agent_messages` gains the four `router_decision_*` columns, filled only on
 * the Smart Router's own attempt row: what the router picked, why, and how
 * long it took. The router hop itself reuses the existing `provider`, `model`,
 * `auth_type` and `tenant_provider_id` columns, and marks itself
 * `superseded = true` so it never counts as the request's primary attempt.
 *
 * No indexes: these columns are write-only and never filtered on.
 */
export class AddSmartRouterConfig1803200000000 implements MigrationInterface {
  name = 'AddSmartRouterConfig1803200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_provider" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_model" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_auth_type" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_key_label" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "smart_router_include_self" boolean NOT NULL DEFAULT true`,
    );

    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_provider" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_model" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_reason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "router_decision_latency_ms" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_latency_ms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_model"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_messages" DROP COLUMN IF EXISTS "router_decision_provider"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_include_self"`,
    );
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_key_label"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_auth_type"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_model"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_provider"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "smart_router_enabled"`);
  }
}
