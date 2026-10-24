import {createClient} from "https://esm.sh/@supabase/supabase-js@2";
const cors={
  "Access-Control-Allow-Origin":"https://powerplant360.github.io",
  "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
  "Access-Control-Allow-Methods":"POST,OPTIONS",
  "Cache-Control":"no-store"
};
function respond(payload:unknown,status=200){
  return new Response(JSON.stringify(payload),{status,headers:{...cors,"Content-Type":"application/json"}});
}
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(req.method!=="POST")return respond({error:"Method not allowed"},405);
  const origin=req.headers.get("origin");
  if(origin && origin!=="https://powerplant360.github.io")return respond({error:"Forbidden"},403);
  try{
    const body=await req.json().catch(()=>({}));
    const identifier=String(body.identifier||"").trim().toLowerCase();
    const password=String(body.password||"");
    if(identifier.length>254||password.length>1024||!password ||
      !/^[a-z][a-z0-9._-]{2,29}$/.test(identifier)){
      return respond({error:"Invalid username or password."},401);
    }
    const url=Deno.env.get("SUPABASE_URL")!;
    const anon=Deno.env.get("SUPABASE_ANON_KEY")!;
    let serverKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
    try{
      const keys=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");
      serverKey=keys?.default||serverKey;
    }catch(_){}
    if(!url||!anon||!serverKey)return respond({error:"Login temporarily unavailable."},503);
    const admin=createClient(url,serverKey,{auth:{persistSession:false,autoRefreshToken:false}});
    let email="";
    for(let page=1;page<=20;page++){
      const {data,error}=await admin.auth.admin.listUsers({page,perPage:1000});
      if(error)throw error;
      const users=data?.users||[];
      const found=users.find((u:any)=>String(u.app_metadata?.pp360_username||"").toLowerCase()===identifier);
      if(found){email=String(found.email||"");break;}
      if(users.length<1000)break;
    }
    if(!email)return respond({error:"Invalid username or password."},401);
    // Password is verified ONLY by Supabase Auth. Never inspect or log it.
    const auth=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data,error}=await auth.auth.signInWithPassword({email,password});
    if(error||!data?.session)return respond({error:"Invalid username or password."},401);
    return respond({access_token:data.session.access_token,refresh_token:data.session.refresh_token});
  }catch(_){
    return respond({error:"Login temporarily unavailable."},503);
  }
});
