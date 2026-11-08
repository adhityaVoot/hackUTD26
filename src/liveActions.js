// Preserve 64-bit IDs without rounding or reinterpreting user-provided strings.
export function serializeArguments(value){
 if(typeof value==='bigint')return value.toString();
 if(value===null)return 'null';
 if(Array.isArray(value))return '['+value.map(serializeArguments).join(',')+']';
 if(typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+':'+serializeArguments(v)).join(',')+'}';
 if(typeof value==='number'&&!Number.isFinite(value))throw Error('Amounts must be finite numbers.');
 const json=JSON.stringify(value);if(json===undefined)throw Error('An action argument is missing.');return json;
}
