import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(process.cwd(), "supabase", "migrations");

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }));

function latestFunctionBody(functionName: string): string {
  const header = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`, "i");
  const latest = migrations.filter(({ sql }) => header.test(sql)).at(-1);
  if (!latest) throw new Error(`${functionName} is not defined in any migration`);
  const start = latest.sql.search(header);
  const bodyStart = latest.sql.indexOf("$$", start);
  const bodyEnd = latest.sql.indexOf("$$", bodyStart + 2);
  return latest.sql.slice(bodyStart + 2, bodyEnd);
}

describe("redeem_invitation migration", () => {
  const body = latestFunctionBody("redeem_invitation");

  it("adds a membership for the inviter's account", () => {
    expect(body).toMatch(/insert\s+into\s+account_memberships/i);
  });

  it("never moves the caller's profile or deletes any account", () => {
    expect(body).not.toMatch(/update\s+profiles/i);
    expect(body).not.toMatch(/delete\s+from\s+accounts/i);
  });

  it("refuses an existing (active or suspended) membership in the invited account", () => {
    expect(body).toMatch(/from\s+account_memberships/i);
    expect(body).toMatch(/already a member of this account/i);
    expect(body).toMatch(/suspended/i);
  });

  it("locks the invitation row so one token cannot be redeemed twice", () => {
    expect(body).toMatch(/from\s+account_invitations\s+where\s+token_hash\s*=\s*p_token_hash\s+for\s+update/i);
  });
});

describe("member RPC migrations", () => {
  it.each(["set_member_role", "remove_account_member", "transfer_account_ownership"])(
    "%s locks the caller and target memberships in user_id order",
    (functionName) => {
      expect(latestFunctionBody(functionName)).toMatch(
        /from\s+account_memberships\s+where\s+account_id\s*=\s*p_account_id\s+and\s+user_id\s+in\s*\(\s*auth\.uid\(\),\s*p_\w+\s*\)\s+order\s+by\s+user_id\s+for\s+update/i,
      );
    },
  );
});
