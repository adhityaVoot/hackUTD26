import {describe,it,expect,vi} from 'vitest';
const captured=vi.hoisted(()=>({settings:null as any}));
vi.mock('react-oidc-context',()=>({AuthProvider:()=>null,useAuth:()=>({})}));
vi.mock('oidc-client-ts',()=>({UserManager:class{constructor(settings:any){captured.settings=settings}},WebStorageStateStore:class{store:any;constructor({store}:any){this.store=store}}}));
// @ts-expect-error Frontend JSX intentionally has no TypeScript declaration.
import {IdentityProvider} from '../../src/IdentityAuth.jsx';
function setup(){
 const session={setItem:vi.fn()},local={setItem:vi.fn()},replace=vi.fn(),dispatch=vi.fn();
 vi.stubGlobal('sessionStorage',session);vi.stubGlobal('localStorage',local);vi.stubGlobal('location',{origin:'http://127.0.0.1:5174',pathname:'/callback',search:'?code=test&state=test'});vi.stubGlobal('history',{replaceState:replace});vi.stubGlobal('document',{title:'Tandem'});vi.stubGlobal('window',{dispatchEvent:dispatch});vi.stubGlobal('HashChangeEvent',class{constructor(public type:string){}});
 const root=IdentityProvider({children:null});return {root,session,local,replace,dispatch};
}
describe('authentication return flow',()=>{
 it('routes a completed authentication into Overview instead of back to sign-in',()=>{const f=setup();f.root.props.onSigninCallback();expect(f.replace).toHaveBeenCalledWith({},'Tandem','/#overview');expect(f.session.setItem).toHaveBeenCalledWith('tandem/auth-mode','auth');expect(f.dispatch).toHaveBeenCalled();});
 it('keeps authentication transactions cross-tab while keeping user tokens tab-scoped',()=>{expect(captured.settings.stateStore.store).toBeDefined();expect(captured.settings.stateStore.store).not.toBe(captured.settings.userStore.store);});
});
