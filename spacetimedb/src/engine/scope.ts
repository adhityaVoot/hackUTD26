import type { Account, Change } from './types';

export function classify(
  changes: Change[],
  accountsById: Map<number, Pick<Account, 'id' | 'isJoint' | 'ownerPersonId'>>,
): 'household' | 'individual' | 'routed' {
  let routed = false;
  for (const change of changes) {
    const params = change.params;
    const ids = [params.accountId, params.fromAccountId, params.toAccountId, params.loanAccountId].filter(
      (id): id is number => typeof id === 'number',
    );
    if (ids.some(id => accountsById.get(id)?.isJoint)) return 'household';
    if (change.kind === 'transfer') {
      const from = accountsById.get(params.fromAccountId as number);
      const to = accountsById.get(params.toAccountId as number);
      if (
        from &&
        to &&
        from.ownerPersonId !== 0 &&
        to.ownerPersonId !== 0 &&
        from.ownerPersonId !== to.ownerPersonId
      ) {
        routed = true;
      }
    }
  }
  return routed ? 'routed' : 'individual';
}
