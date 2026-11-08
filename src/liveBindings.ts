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
const tablesSchema = __schema({myMember: __table({name:"my_member",indexes:[],constraints:[]},__t.row({personId: __t.u64().name("person_id"),displayName: __t.string().name("display_name"),role: __t.string().name("role"),householdId: __t.u64().name("household_id"),stepUpValidUntilMicros: __t.i64().name("step_up_valid_until_micros")})),myHousehold: __table({name:"my_household",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),name: __t.string().name("name"),simDay: __t.i32().name("sim_day"),aiEnabled: __t.bool().name("ai_enabled"),clockRunning: __t.bool().name("clock_running"),cosignThresholdCents: __t.i64().name("cosign_threshold_cents"),baselineScenarioId: __t.u64().name("baseline_scenario_id")})),householdPeople: __table({name:"household_people",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),displayName: __t.string().name("display_name"),role: __t.string().name("role"),personaKey: __t.string().name("persona_key"),online: __t.bool().name("online")})),myAccounts: __table({name:"my_accounts",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),nickname: __t.string().name("nickname"),kind: __t.string().name("kind"),isJoint: __t.bool().name("is_joint"),ownerPersonId: __t.u64().name("owner_person_id"),visibility: __t.string().name("visibility"),balanceCents: __t.i64().name("balance_cents"),limitCents: __t.i64().name("limit_cents"),aprBps: __t.i32().name("apr_bps")})),myGrants: __table({name:"my_grants",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),accountId: __t.u64().name("account_id"),grantorPersonId: __t.u64().name("grantor_person_id"),granteePersonId: __t.u64().name("grantee_person_id"),level: __t.string().name("level"),historyWindowDays: __t.i32().name("history_window_days"),expiresAt: __t.timestamp().name("expires_at"),status: __t.string().name("status")})),householdConsentLog: __table({name:"household_consent_log",indexes:[],constraints:[]},__t.row({id: __t.u64().name("id"),actorPersonId: __t.u64().name("actor_person_id"),accountId: __t.u64().name("account_id"),action: __t.string().name("action"),detail: __t.string().name("detail"),at: __t.timestamp().name("at")}))});

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

