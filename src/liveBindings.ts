// Client view adapter derived from deployed schema. No private tables are exposed.
// Replace with regenerated backend bindings when available.

// This was generated using spacetimedb cli version 2.14.1 (commit a0bf6be10a146b03acbe3f4f9ad7fe20f114988d).

/* eslint-disable */
/* tslint:disable */
import {
  DbConnectionBuilder as __DbConnectionBuilder,
  DbConnectionImpl as __DbConnectionImpl,
  SubscriptionBuilderImpl as __SubscriptionBuilderImpl,
  TypeBuilder as __TypeBuilder,
  Uuid as __Uuid,
  convertToAccessorMap as __convertToAccessorMap,
  makeQueryBuilder as __makeQueryBuilder,
  procedureSchema as __procedureSchema,
  procedures as __procedures,
  reducerSchema as __reducerSchema,
  reducers as __reducers,
  schema as __schema,
  t as __t,
  table as __table,
  type AlgebraicTypeType as __AlgebraicTypeType,
  type DbConnectionConfig as __DbConnectionConfig,
  type ErrorContextInterface as __ErrorContextInterface,
  type Event as __Event,
  type EventContextInterface as __EventContextInterface,
  type Infer as __Infer,
  type QueryBuilder as __QueryBuilder,
  type ReducerEventContextInterface as __ReducerEventContextInterface,
  type RemoteModule as __RemoteModule,
  type SubscriptionEventContextInterface as __SubscriptionEventContextInterface,
  type SubscriptionHandleImpl as __SubscriptionHandleImpl,
} from "spacetimedb";

// Import all reducer arg schemas

// Import all procedure arg schemas

// Import all table schema definitions


/** Type-only namespace exports for generated type groups. */

/** The schema information for all tables in this module. This is defined the same was as the tables would have been defined in the server. */
const tablesSchema = __schema({householdApprovals: __table({name:"household_approvals",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),scenarioId: __t.u64().name("scenario_id"),householdId: __t.u64().name("household_id"),personId: __t.u64().name("person_id"),decision: __t.string().name("decision"),at: __t.timestamp().name("at")})),householdCommitments: __table({name:"household_commitments",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),householdId: __t.u64().name("household_id"),scenarioId: __t.u64().name("scenario_id"),label: __t.string().name("label"),dueDay: __t.i32().name("due_day"),done: __t.bool().name("done"),transferFromAccountId: __t.u64().name("transfer_from_account_id"),transferToAccountId: __t.u64().name("transfer_to_account_id"),amountCents: __t.i64().name("amount_cents"),bankStatus: __t.string().name("bank_status"),nessieTransferId: __t.string().name("nessie_transfer_id")})),householdConsentLog: __table({name:"household_consent_log",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),actorPersonId: __t.u64().name("actor_person_id"),accountId: __t.u64().name("account_id"),action: __t.string().name("action"),detail: __t.string().name("detail"),at: __t.timestamp().name("at")})),householdPeople: __table({name:"household_people",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),displayName: __t.string().name("display_name"),role: __t.string().name("role"),personaKey: __t.string().name("persona_key"),online: __t.bool().name("online")})),householdPresence: __table({name:"household_presence",indexes:[],constraints:[]},__t.row({identity: __t.identity().name("identity"),householdId: __t.u64().name("household_id"),personId: __t.u64().name("person_id"),scenarioId: __t.u64().name("scenario_id"),updatedAt: __t.timestamp().name("updated_at")})),householdScenarios: __table({name:"household_scenarios",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),householdId: __t.u64().name("household_id"),parentId: __t.u64().name("parent_id"),authorPersonId: __t.u64().name("author_person_id"),agentKind: __t.string().name("agent_kind"),title: __t.string().name("title"),explanation: __t.string().name("explanation"),status: __t.string().name("status"),scope: __t.string().name("scope"),audiencePersonId: __t.u64().name("audience_person_id"),createdAt: __t.timestamp().name("created_at"),computedAtDay: __t.i32().name("computed_at_day")})),myAccounts: __table({name:"my_accounts",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),nickname: __t.string().name("nickname"),kind: __t.string().name("kind"),isJoint: __t.bool().name("is_joint"),ownerPersonId: __t.u64().name("owner_person_id"),visibility: __t.string().name("visibility"),balanceCents: __t.i64().name("balance_cents"),limitCents: __t.i64().name("limit_cents"),aprBps: __t.i32().name("apr_bps")})),myAlerts: __table({name:"my_alerts",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),householdId: __t.u64().name("household_id"),routedToPersonId: __t.u64().name("routed_to_person_id"),aboutPersonId: __t.u64().name("about_person_id"),kind: __t.string().name("kind"),day: __t.i32().name("day"),riskPct: __t.f64().name("risk_pct"),scenarioId: __t.u64().name("scenario_id"),message: __t.string().name("message"),read: __t.bool().name("read"),createdAt: __t.timestamp().name("created_at")})),myForecast: __table({name:"my_forecast",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),scenarioId: __t.u64().name("scenario_id"),householdId: __t.u64().name("household_id"),accountId: __t.u64().name("account_id"),day: __t.i32().name("day"),p10Cents: __t.i64().name("p_10_cents"),p50Cents: __t.i64().name("p_50_cents"),p90Cents: __t.i64().name("p_90_cents"),pBelowBuffer: __t.f64().name("p_below_buffer")})),myGrants: __table({name:"my_grants",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),accountId: __t.u64().name("account_id"),grantorPersonId: __t.u64().name("grantor_person_id"),granteePersonId: __t.u64().name("grantee_person_id"),level: __t.string().name("level"),historyWindowDays: __t.i32().name("history_window_days"),expiresAt: __t.timestamp().name("expires_at"),status: __t.string().name("status")})),myHousehold: __table({name:"my_household",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),name: __t.string().name("name"),simDay: __t.i32().name("sim_day"),aiEnabled: __t.bool().name("ai_enabled"),clockRunning: __t.bool().name("clock_running"),cosignThresholdCents: __t.i64().name("cosign_threshold_cents"),baselineScenarioId: __t.u64().name("baseline_scenario_id")})),myInviteCode: __table({name:"my_invite_code",indexes:[],constraints:[]},__t.row({inviteCode: __t.string().name("invite_code")})),myMember: __table({name:"my_member",indexes:[],constraints:[]},__t.row({personId: __t.u64().name("person_id"),displayName: __t.string().name("display_name"),role: __t.string().name("role"),householdId: __t.u64().name("household_id"),stepUpValidUntilMicros: __t.i64().name("step_up_valid_until_micros")})),myObligations: __table({name:"my_obligations",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),accountId: __t.u64().name("account_id"),kind: __t.string().name("kind"),label: __t.string().name("label"),amountCents: __t.i64().name("amount_cents"),cadence: __t.string().name("cadence"),anchorDay: __t.i32().name("anchor_day"),flexible: __t.bool().name("flexible"),active: __t.bool().name("active")})),myTxns: __table({name:"my_txns",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),accountId: __t.u64().name("account_id"),day: __t.i32().name("day"),amountCents: __t.i64().name("amount_cents"),category: __t.string().name("category"),merchantCode: __t.string().name("merchant_code"),rawDescription: __t.string().name("raw_description")})),myVitals: __table({name:"my_vitals",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),scenarioId: __t.u64().name("scenario_id"),householdId: __t.u64().name("household_id"),scopePersonId: __t.u64().name("scope_person_id"),key: __t.string().name("key"),value: __t.f64().name("value"),band: __t.string().name("band"),why: __t.string().name("why"),mathJson: __t.string().name("math_json")})),scenarioChanges: __table({name:"scenario_changes",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),scenarioId: __t.u64().name("scenario_id"),householdId: __t.u64().name("household_id"),kind: __t.string().name("kind"),paramsJson: __t.string().name("params_json"),label: __t.string().name("label")}))});

/** The schema information for all reducers in this module. This is defined the same way as the reducers would have been defined in the server, except the body of the reducer is omitted in code generation. */
const reducersSchema = __reducers(
);

/** The schema information for all procedures in this module. This is defined the same way as the procedures would have been defined in the server. */
const proceduresSchema = __procedures(
);

/** The remote SpacetimeDB module schema, both runtime and type information. */
const REMOTE_MODULE = {
  versionInfo: {
    cliVersion: "2.14.1" as const,
  },
  tables: tablesSchema.schemaType.tables,
  reducers: reducersSchema.reducersType.reducers,
  ...proceduresSchema,
} satisfies __RemoteModule<
  typeof tablesSchema.schemaType,
  typeof reducersSchema.reducersType,
  typeof proceduresSchema
>;

/** The tables available in this remote SpacetimeDB module. Each table reference doubles as a query builder. */
export const tables: __QueryBuilder<typeof tablesSchema.schemaType> = __makeQueryBuilder(tablesSchema.schemaType);

/** The reducers available in this remote SpacetimeDB module. */
export const reducers = __convertToAccessorMap(reducersSchema.reducersType.reducers);

/** The procedures available in this remote SpacetimeDB module. */
export const procedures = __convertToAccessorMap(proceduresSchema.procedures);

/** The context type returned in callbacks for all possible events. */
export type EventContext = __EventContextInterface<typeof REMOTE_MODULE>;
/** The context type returned in callbacks for reducer events. */
export type ReducerEventContext = __ReducerEventContextInterface<typeof REMOTE_MODULE>;
/** The context type returned in callbacks for subscription events. */
export type SubscriptionEventContext = __SubscriptionEventContextInterface<typeof REMOTE_MODULE>;
/** The context type returned in callbacks for error events. */
export type ErrorContext = __ErrorContextInterface<typeof REMOTE_MODULE>;
/** The subscription handle type to manage active subscriptions created from a {@link SubscriptionBuilder}. */
export type SubscriptionHandle = __SubscriptionHandleImpl<typeof REMOTE_MODULE>;

/** Builder class to configure a new subscription to the remote SpacetimeDB instance. */
export class SubscriptionBuilder extends __SubscriptionBuilderImpl<typeof REMOTE_MODULE> {}

/** Builder class to configure a new database connection to the remote SpacetimeDB instance. */
export class DbConnectionBuilder extends __DbConnectionBuilder<DbConnection> {}

/** The typed database connection to manage connections to the remote SpacetimeDB instance. This class has type information specific to the generated module. */
export class DbConnection extends __DbConnectionImpl<typeof REMOTE_MODULE> {
  /** Creates a new {@link DbConnectionBuilder} to configure and connect to the remote SpacetimeDB instance. */
  static builder = (): DbConnectionBuilder => {
    return new DbConnectionBuilder(REMOTE_MODULE, (config: __DbConnectionConfig<typeof REMOTE_MODULE>) => new DbConnection(config));
  };

  /** Creates a new {@link SubscriptionBuilder} to configure a subscription to the remote SpacetimeDB instance. */
  override subscriptionBuilder = (): SubscriptionBuilder => {
    return new SubscriptionBuilder(this);
  };
}

