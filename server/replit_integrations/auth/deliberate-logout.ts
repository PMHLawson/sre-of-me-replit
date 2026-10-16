import type { Express, RequestHandler } from "express";
import { matchedOrigin } from "../../../shared/trusted-addresses";

export const deliberateLogout: RequestHandler = (req,res,next) => {
  if(req.method!=="POST"){res.set("Allow","POST").status(405).end();return;}
  const values=(name:string)=>req.rawHeaders.flatMap((v,i)=>i%2===0&&v.toLowerCase()===name?[req.rawHeaders[i+1]]:[]);
  const origins=values("origin"), intent=values("x-sre-logout");
  if(origins.length!==1 || origins[0]!==matchedOrigin(req) ||
    intent.length!==1 || intent[0]!=="1" ||
    (req.get("sec-fetch-site")!==undefined && req.get("sec-fetch-site")!=="same-origin")){
    res.status(403).json({message:"Sign-out request rejected"});return;
  }
  next();
};

export function registerLogout(app:Express, providerDestination:(origin:string)=>string){
  app.post("/api/logout",async(req,res)=>{
    res.set("Cache-Control","no-store");
    try{
      // Passport actually saves and regenerates here. Neither callback may be
      // ignored; failure means we cannot honestly confirm the whole operation.
      await new Promise<void>((resolve,reject)=>req.logout(error=>error?reject(error):resolve()));
      await new Promise<void>((resolve,reject)=>req.session.destroy(error=>error?reject(error):resolve()));
    }catch{
      res.status(503).json({message:"Sign-out could not be confirmed. Please retry."});return;
    }
    res.clearCookie("connect.sid",{path:"/",httpOnly:true,secure:true,sameSite:"lax"});
    let providerLogoutUrl:string|null=null;
    try{providerLogoutUrl=providerDestination(matchedOrigin(req));}catch{}
    res.json({localSignedOut:true,providerLogoutUrl,providerHandoffUnavailable:providerLogoutUrl===null});
  });
}
