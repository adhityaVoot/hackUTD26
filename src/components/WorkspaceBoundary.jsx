import React from 'react';
export default class WorkspaceBoundary extends React.Component{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true}}
 render(){if(!this.state.failed)return this.props.children;return <section className="workspace-recovery" role="alert"><h2>This workspace couldn’t load.</h2><p>Your navigation is still available. Try again or return to Family overview.</p><div><button onClick={()=>this.setState({failed:false})}>Try again</button><a href="#summary">Family overview</a></div></section>}
}
