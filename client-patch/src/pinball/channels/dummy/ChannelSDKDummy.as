package pinball.channels.dummy
{
   import flash.Boot;
   import flash.Lib;
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.MouseEvent;
   import flash.net.URLLoader;
   import flash.net.URLRequest;
   import flash.net.URLRequestMethod;
   import flash.text.TextField;
   import flash.text.TextFieldAutoSize;
   import flash.text.TextFieldType;
   import flash.text.TextFormat;
   import flash.utils.getTimer;
   import pinball.channels.ChannelSDKImpl;
   import pinball.config.core.DevConfig;
   import pinball.context.Logic;
   import pinball.context.localStore._DeviceLocalStore.DeviceLocalStore_Impl_;
   import pinball.context.remote.PlayerIdMode;
   import pinball.context.remote.RemoteError;
   import pinball.context.remote.RequestQueue;
   import pinball.context.remote.RequestSetting;
   import pinball.context.remote.real.RealRemote;
   import pinball.context.remote.real.RealRemoteService;
   import pinball.context.scene.instantMessage.InstantMessagePosition;
   import pinball.remote.common.ResponseData;
   import pinball.scene.title.TitleScene;
   
   /**
    * P6 自研登录页（账号绑定）——被覆盖的宿主类。
    *
    * 回填方式：路线 B（只换既有方法体），靶 FQCN = pinball.channels.dummy.ChannelSDKDummy。
    * 本文件只改 5 个既有方法体，其余方法体是「可编译占位」，不会进入最终 SWF
    * （最终 SWF 由路线 B 按 body 下标注入靶方法体的 pcode，其它方法体保持 base.swf 原样）。
    *
    * 被改写的 5 个方法体（全部是既有方法，未新增方法、未新增字段、未新增类）：
    *   1. startLoginServer(param1:Function):void   —— 接缝入口，建页 + 取 device_id + 挂帧/点击监听
    *   2. testLogin():void                          —— 帧循环：超时、倒计时、轮询调度、重绘
    *   3. testLoginReport():void                    —— 点击派发（stage MOUSE_DOWN + 坐标命中）
    *   4. testHeartbeat():void                      —— 网络回包处理（URLLoader COMPLETE/IO_ERROR）
    *   5. dispose():void                            —— 拆页清理
    * 选槽依据：testConnect 在本客户端恒 false（全树无处置 true），故 testLogin/testLoginReport/
    * testHeartbeat 三个方法是事实死代码；dispose 是框架钩子；update(param1:Number) 参数类型是
    * Number，作为事件监听器会被参数强制转换，故不用。
    *
    * 约束遵守：不写第二个地址常量（基址由 remote.devConfig.getServerApiPath() 推导）；
    * 只 import flash.* 与既有 pinball.* 类；state 存在 SWF 根 MovieClip 的动态属性 sp6 上。
    */
   public class ChannelSDKDummy extends RealRemoteService implements ChannelSDKImpl
   {
      
      public var userId:String;
      
      public var titleScene:TitleScene;
      
      public var testConnect:Boolean;
      
      public var overTime:Number;
      
      public var lastOperationTime:Number;
      
      public var completeHandler:Function;
      
      public function ChannelSDKDummy(param1:RealRemote = undefined, param2:Logic = undefined)
      {
         if(Boot.skip_constructor)
         {
            return;
         }
         testConnect = false;
         userId = "abcde001";
         overTime = 30;
         titleScene = null;
         if(null != param1)
         {
            super(param1);
         }
      }
      
      // ===================================================================
      // [未改动占位] update：框架每帧调用（参数 Number，不适合当事件监听器，故不复用）
      // ===================================================================
      public function update(param1:Number) : void
      {
      }
      
      // ===================================================================
      // [未改动占位] testLoginReport 的旧体是 SDK 自测上报，testConnect 恒 false 永不执行
      // ===================================================================
      
      // ===================================================================
      // 靶方法体 1/5：接缝入口
      // 原：public function startLoginServer(param1:Function) : void { param1(""); }
      // 新：建登录页、取本机 device_id、把 handler 存进 state、挂帧与点击监听
      // ===================================================================
      public function startLoginServer(param1:Function) : void
      {
         var root:Object = Lib.current;
         var st:Object = root["sp6"];
         if(st != null)
         {
            st["handler"] = param1;
            if(st["done"] == true)
            {
               param1(String(st["dev"]));
            }
            return;
         }
         st = {};
         st["handler"] = param1;
         st["root"] = root;
         st["stage"] = Lib.current.stage;
         st["panel"] = "home";
         st["mode"] = "login";
         st["dirty"] = true;
         st["net"] = false;
         st["loader"] = null;
         st["req"] = "";
         st["want"] = null;
         st["msg"] = "";
         st["token"] = "";
         st["code"] = "";
         st["codeShown"] = "";
         st["codeLeft"] = 0;
         st["codeAt"] = 0;
         st["pollAt"] = 0;
         st["pollGap"] = 3000;
         st["deadline"] = 0;
         st["user"] = "";
         st["pass"] = "";
         st["tries"] = 0;
         st["done"] = false;
         st["dev"] = 0;
         st["sc"] = 1;
         st["ui"] = null;
         st["btns"] = [];
         st["tfU"] = null;
         st["tfP"] = null;
         st["tfCode"] = null;
         st["tfTimer"] = null;
         var dev:Number = 0;
         var d:Object = null;
         try
         {
            d = DeviceLocalStore_Impl_.get(localStore.get_device());
         }
         catch(e:Error)
         {
            d = null;
         }
         if(d != null)
         {
            dev = Number(d["deviceId"]);
         }
         if(!(dev > 0))
         {
            dev = 1;
         }
         st["dev"] = dev;
         var path:String = String(remote.devConfig.getServerApiPath());
         var cut:int = path.indexOf("/api/index.php");
         var base:String = cut >= 0 ? path.substring(0,cut) : path;
         st["base"] = base;
         root["sp6"] = st;
         root.addEventListener(Event.ENTER_FRAME,this.testLogin);
         Lib.current.stage.addEventListener(MouseEvent.MOUSE_DOWN,this.testLoginReport);
      }
      
      // ===================================================================
      // [未改动占位] sdkLoginManual：接缝未用（params 类型 Function，作为监听器会被强制转换）
      // ===================================================================
      public function sdkLoginManual(param1:Function) : void
      {
         param1("");
      }
      
      public function sdkLogin(param1:Function) : void
      {
         param1("");
      }
      
      public function sdkInit(param1:String, param2:Function) : void
      {
         param2();
      }
      
      public function sdKAgreePrivacyComplete(param1:Function) : void
      {
         param1();
      }
      
      public function reset(param1:TitleScene) : void
      {
         titleScene = param1;
      }
      
      public function onTestHeartbeat(param1:ResponseData) : void
      {
      }
      
      public function loginSuccessHandler(param1:ResponseData) : void
      {
      }
      
      public function loginReportSuccessHandler(param1:ResponseData) : void
      {
      }
      
      public function isServerloginResponsed() : Boolean
      {
         return true;
      }
      
      public function isSDKLogining() : Boolean
      {
         return false;
      }
      
      public function isSDKLoginOk() : Boolean
      {
         return true;
      }
      
      public function isRealSDK() : Boolean
      {
         return false;
      }
      
      public function getResponeLoginReportData() : Object
      {
         return null;
      }
      
      public function getResponeLoginData() : Object
      {
         return null;
      }
      
      public function getLogoutReportPath() : String
      {
         return "";
      }
      
      public function getLoginReportPath() : String
      {
         return "";
      }
      
      public function errorHandler(param1:RemoteError) : void
      {
      }
      
      public function enterGame() : void
      {
      }
      
      // ===================================================================
      // 靶方法体 2/5：帧循环（原 testLogin 是死代码）
      // 职责：网络超时、轮询调度、倒计时、按需重绘
      // ===================================================================
      public function testLogin() : void
      {
         var root:Object = Lib.current;
         var st:Object = root["sp6"];
         if(st == null)
         {
            return;
         }
         if(st["done"] == true)
         {
            root.removeEventListener(Event.ENTER_FRAME,this.testLogin);
            return;
         }
         var now:int = getTimer();
         var stage:Object = st["stage"];
         var sc:Number = Number(stage.stageWidth) / 375;
         st["sc"] = sc;
         var ldr:URLLoader = null;
         var w:Object = null;
         var req:URLRequest = null;
         var pb:Object = null;
         var ptag:String = "";
         var purl:String = "";
         var left:int = 0;
         var mm:int = 0;
         var ss:int = 0;
         var tt:String = "";
         var i:int = 0;
         var j:int = 0;
         var lines:Array = null;
         var ln:Array = null;
         var tf:TextField = null;
         var fmt:TextFormat = null;
         var ui:Object = null;
         var card:Sprite = null;
         var sp:Sprite = null;
         var btns:Array = null;
         var b:Array = null;
         var h0:Number = 0;
         var W:Number = 0;
         var H:Number = 0;
         var ch:Number = 0;
         var cy:Number = 0;
         var bx:Number = 0;
         var by:Number = 0;
         var bw:Number = 0;
         var bh:Number = 0;
         var col:uint = 0;
         var al:Number = 1;
         var sz:Number = 0;
         var bold:Boolean = false;
         var txt:String = "";
         var panel:String = String(st["panel"]);
         // ---- 网络超时 ----
         if(st["net"] == true && now > int(st["deadline"]))
         {
            ldr = st["loader"] as URLLoader;
            if(ldr != null)
            {
               try
               {
                  ldr.close();
               }
               catch(e:Error)
               {
               }
            }
            st["loader"] = null;
            st["net"] = false;
            st["req"] = "";
            st["msg"] = "网络异常，请重试";
            st["dirty"] = true;
         }
         // ---- 输入框回读（受密码框遮罩保护，仅内存） ----
         if(panel == "input")
         {
            if(st["tfU"] != null)
            {
               st["user"] = String(st["tfU"].text);
            }
            if(st["tfP"] != null)
            {
               st["pass"] = String(st["tfP"].text);
            }
         }
         // ---- 发送排队中的请求（全页唯一的发请求点） ----
         if(st["net"] == false && st["want"] != null)
         {
            w = st["want"];
            st["want"] = null;
            st["req"] = String(w["tag"]);
            req = new URLRequest(String(w["url"]));
            req.method = URLRequestMethod.POST;
            req.contentType = "application/json";
            req.data = String(w["body"]);
            ldr = new URLLoader();
            ldr.addEventListener(Event.COMPLETE,this.testHeartbeat);
            ldr.addEventListener(IOErrorEvent.IO_ERROR,this.testHeartbeat);
            st["loader"] = ldr;
            st["net"] = true;
            st["deadline"] = now + 15000;
            try
            {
               ldr.load(req);
            }
            catch(e2:Error)
            {
               st["loader"] = null;
               st["net"] = false;
               st["req"] = "";
               st["msg"] = "网络异常，请重试";
               st["dirty"] = true;
            }
         }
         else if(st["want"] == null && st["net"] == false && panel == "code" && int(st["codeLeft"]) > 0 && now >= int(st["pollAt"]))
         {
            // 绑定轮询：有 token 用 bind-status；无 token（login 返回 BIND_REQUIRED 且服务端未带 token）用 login 复打
            ptag = String(st["token"]) != "" ? "bind" : "login";
            if(ptag == "bind")
            {
               purl = String(st["base"]) + "/sp-auth/bind-status";
               pb = {"token":st["token"],"device_id":st["dev"]};
            }
            else
            {
               purl = String(st["base"]) + "/sp-auth/login";
               pb = {"login_name":st["user"],"password":st["pass"],"device_id":st["dev"]};
            }
            st["want"] = {"tag":ptag,"url":purl,"body":JSON.stringify(pb)};
         }
         // ---- 码页倒计时与码文本（码不变就不动文本，避免闪动） ----
         if(panel == "code")
         {
            left = int((int(st["codeAt"]) - now) / 1000);
            if(left < 0)
            {
               left = 0;
            }
            st["codeLeft"] = left;
            if(st["tfTimer"] != null)
            {
               mm = left / 60;
               ss = left % 60;
               tt = (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
               st["tfTimer"].text = "有效期剩余 " + tt;
            }
            if(st["code"] != st["codeShown"])
            {
               st["codeShown"] = st["code"];
               if(st["tfCode"] != null)
               {
                  st["tfCode"].text = String(st["code"]);
               }
            }
            if(left == 0 && String(st["msg"]) == "" && int(st["codeAt"]) > 0)
            {
               st["msg"] = "验证码已过期，请点「重新获取验证码」。";
               st["dirty"] = true;
            }
         }
         // ---- 按需重绘 ----
         if(st["dirty"] != true)
         {
            return;
         }
         st["dirty"] = false;
         W = 375;
         h0 = Number(stage.stageHeight);
         H = h0 / sc;
         ui = st["ui"];
         if(ui != null)
         {
            stage.removeChild(ui);
         }
         ui = new Sprite();
         ui.scaleX = sc;
         ui.scaleY = sc;
         stage.addChild(ui);
         st["ui"] = ui;
         ui.graphics.beginFill(0x103B39,0.46);
         ui.graphics.drawRect(0,0,W,H);
         ui.graphics.endFill();
         st["btns"] = [];
         st["tfCode"] = null;
         st["tfTimer"] = null;
         st["tfU"] = null;
         st["tfP"] = null;
         ch = 300;
         if(panel == "input")
         {
            ch = 372;
         }
         else if(panel == "code")
         {
            ch = 424;
         }
         if(String(st["msg"]) != "")
         {
            ch += 30;
         }
         cy = (H - ch) / 2;
         card = new Sprite();
         ui.addChild(card);
         card.graphics.beginFill(0x123E39,0.18);
         card.graphics.drawRoundRect(20,cy + 8,335,ch,26);
         card.graphics.endFill();
         card.graphics.beginFill(0xF8FCF8,1);
         card.graphics.drawRoundRect(20,cy,335,ch,26);
         card.graphics.endFill();
         // ---- 文案行 ----
         lines = [];
         if(panel == "home")
         {
            lines = [["账号登录",44,cy + 36,24,0x294943,true],["本机首次进入需要创建账号，",44,cy + 78,14,0x849891,false],["账号将与本机绑定，绑定后可在其它设备登录。",44,cy + 100,14,0x849891,false],["创建后会显示 6 位绑定码，",44,cy + 130,14,0x849891,false],["发给客服机器人完成 QQ / KOOK 绑定即可进入游戏。",44,cy + 152,14,0x849891,false]];
         }
         else if(panel == "input")
         {
            txt = panel == "input" && String(st["mode"]) == "register" ? "自定义账号创建" : "账号密码登录";
            lines = [[txt,44,cy + 34,22,0x294943,true],["用户名",44,cy + 84,13,0x849891,false],["密码",44,cy + 168,13,0x849891,false]];
            if(String(st["mode"]) == "register")
            {
               lines.push(["4-20 位字母/数字/下划线，不能以数字开头",44,cy + 262,12,0x849891,false]);
               lines.push(["密码 8-64 位，需含大写、小写和数字",44,cy + 282,12,0x849891,false]);
            }
         }
         else if(panel == "code")
         {
            lines = [["绑定 QQ / KOOK",44,cy + 32,22,0x294943,true],["请把下面的 6 位绑定码发给客服机器人，",44,cy + 70,13,0x849891,false],["绑定成功后本页会自动继续进入游戏。",44,cy + 90,13,0x849891,false],["账号 " + String(st["user"]),44,cy + 258,12,0x849891,false],["密码 " + String(st["pass"]),44,cy + 278,12,0x849891,false],["（请截图保存，绑定后也可用 QQ / KOOK 登录）",44,cy + 298,12,0x849891,false]];
         }
         i = 0;
         while(i < lines.length)
         {
            ln = lines[i];
            tf = new TextField();
            tf.autoSize = TextFieldAutoSize.LEFT;
            tf.selectable = false;
            tf.mouseEnabled = false;
            fmt = new TextFormat("SY",Number(ln[3]),uint(ln[4]),Boolean(ln[5]));
            tf.defaultTextFormat = fmt;
            tf.text = String(ln[0]);
            tf.x = Number(ln[1]);
            tf.y = Number(ln[2]);
            card.addChild(tf);
            i++;
         }
         // ---- 码页：码框 + 倒计时 ----
         if(panel == "code")
         {
            card.graphics.beginFill(0x20B9AA,0.08);
            card.graphics.drawRoundRect(44,cy + 118,287,74,20);
            card.graphics.endFill();
            card.graphics.lineStyle(2,0x20B9AA,0.35);
            card.graphics.drawRoundRect(44,cy + 118,287,74,20);
            card.graphics.lineStyle();
            tf = new TextField();
            tf.autoSize = TextFieldAutoSize.LEFT;
            tf.selectable = true;
            tf.mouseEnabled = false;
            fmt = new TextFormat("SY",34,0x20B9AA,true);
            fmt.letterSpacing = 6;
            tf.defaultTextFormat = fmt;
            tf.text = String(st["code"]);
            tf.x = 44 + (287 - tf.width) / 2;
            tf.y = cy + 134;
            card.addChild(tf);
            st["tfCode"] = tf;
            st["codeShown"] = String(st["code"]);
            tf = new TextField();
            tf.autoSize = TextFieldAutoSize.LEFT;
            tf.selectable = false;
            tf.mouseEnabled = false;
            fmt = new TextFormat("SY",13,0x849891,false);
            tf.defaultTextFormat = fmt;
            tf.text = "有效期剩余 --:--";
            tf.x = 44 + (287 - tf.width) / 2;
            tf.y = cy + 212;
            card.addChild(tf);
            st["tfTimer"] = tf;
         }
         // ---- 输入框（登录 / 自定义创建面板） ----
         if(panel == "input")
         {
            tf = new TextField();
            tf.type = TextFieldType.INPUT;
            tf.border = true;
            tf.background = true;
            tf.backgroundColor = 0xFFFFFF;
            tf.borderColor = 0xD8E4E0;
            tf.defaultTextFormat = new TextFormat("SY",16,0x294943,false);
            tf.restrict = "A-Za-z0-9_";
            tf.maxChars = 20;
            tf.text = String(st["user"]);
            tf.x = 44;
            tf.y = cy + 106;
            tf.width = 287;
            tf.height = 46;
            card.addChild(tf);
            st["tfU"] = tf;
            tf = new TextField();
            tf.type = TextFieldType.INPUT;
            tf.border = true;
            tf.background = true;
            tf.backgroundColor = 0xFFFFFF;
            tf.borderColor = 0xD8E4E0;
            tf.displayAsPassword = true;
            tf.defaultTextFormat = new TextFormat("SY",16,0x294943,false);
            tf.maxChars = 64;
            tf.text = String(st["pass"]);
            tf.x = 44;
            tf.y = cy + 190;
            tf.width = 287;
            tf.height = 46;
            card.addChild(tf);
            st["tfP"] = tf;
            st["btns"].push({"x":44,"y":cy + 106,"w":287,"h":46,"act":"fu"});
            st["btns"].push({"x":44,"y":cy + 190,"w":287,"h":46,"act":"fp"});
         }
         // ---- 按钮 / 链接 ----
         btns = [];
         if(panel == "home")
         {
            btns = [["创建账号","register",0],["已有账号？用账号密码登录","input",1]];
         }
         else if(panel == "input")
         {
            txt = String(st["mode"]) == "register" ? "创建并获取绑定码" : "登录";
            btns = [[txt,"submit",0],["返回","back",1]];
         }
         else if(panel == "code")
         {
            btns = [["我已完成绑定","check",0],["重新获取验证码","resend",1]];
         }
         by = cy + ch - 104;
         i = 0;
         while(i < btns.length)
         {
            b = btns[i];
            txt = String(b[0]);
            if(int(b[2]) == 0)
            {
               bw = 287;
               bh = 52;
               bx = 44;
               col = 0x20B9AA;
               al = st["net"] == true ? 0.45 : 1;
               card.graphics.beginFill(col,al);
               card.graphics.drawRoundRect(bx,by,bw,bh,24);
               card.graphics.endFill();
               tf = new TextField();
               tf.autoSize = TextFieldAutoSize.LEFT;
               tf.selectable = false;
               tf.mouseEnabled = false;
               fmt = new TextFormat("SY",17,0xFFFFFF,true);
               tf.defaultTextFormat = fmt;
               tf.text = st["net"] == true ? "请稍候…" : txt;
               tf.x = bx + (bw - tf.width) / 2;
               tf.y = by + (bh - tf.height) / 2 - 2;
               card.addChild(tf);
               st["btns"].push({"x":bx,"y":by,"w":bw,"h":bh,"act":String(b[1])});
               by += 64;
            }
            else
            {
               tf = new TextField();
               tf.autoSize = TextFieldAutoSize.LEFT;
               tf.selectable = false;
               tf.mouseEnabled = false;
               fmt = new TextFormat("SY",15,0x20B9AA,false);
               tf.defaultTextFormat = fmt;
               tf.text = txt;
               tf.x = (W - tf.width) / 2;
               tf.y = by + 8;
               card.addChild(tf);
               st["btns"].push({"x":44,"y":by,"w":287,"h":36,"act":String(b[1])});
               by += 44;
            }
            i++;
         }
         // ---- 错误条 / 提示条 ----
         if(String(st["msg"]) != "")
         {
            tf = new TextField();
            tf.autoSize = TextFieldAutoSize.LEFT;
            tf.selectable = false;
            tf.mouseEnabled = false;
            fmt = new TextFormat("SY",13,0xEA3553,false);
            tf.defaultTextFormat = fmt;
            tf.text = String(st["msg"]);
            if(tf.width > 287)
            {
               tf.width = 287;
               tf.multiline = true;
               tf.wordWrap = true;
            }
            tf.x = 44;
            tf.y = cy + ch - 130;
            card.addChild(tf);
         }
      }
      
      // ===================================================================
      // 靶方法体 3/5：点击派发（原 testLoginReport 是死代码）
      // 无参签名 ⇒ 安全作为 MouseEvent 监听器（不触发参数强制转换）；
      // 命中判定用 stage.mouseX/mouseY 除以缩放，与绘制坐标系一致。
      // ===================================================================
      public function testLoginReport() : void
      {
         var root:Object = Lib.current;
         var st:Object = root["sp6"];
         if(st == null || st["done"] == true)
         {
            return;
         }
         var panel:String = String(st["panel"]);
         if(panel == "input")
         {
            if(st["tfU"] != null)
            {
               st["user"] = String(st["tfU"].text);
            }
            if(st["tfP"] != null)
            {
               st["pass"] = String(st["tfP"].text);
            }
         }
         var stage:Object = st["stage"];
         var sc:Number = Number(st["sc"]);
         if(!(sc > 0))
         {
            sc = 1;
         }
         var mx:Number = Number(stage.mouseX) / sc;
         var my:Number = Number(stage.mouseY) / sc;
         var btns:Array = st["btns"] as Array;
         if(btns == null)
         {
            return;
         }
         var act:String = "";
         var i:int = 0;
         var b:Object = null;
         while(i < btns.length)
         {
            b = btns[i];
            if(mx >= Number(b["x"]) && mx <= Number(b["x"]) + Number(b["w"]) && my >= Number(b["y"]) && my <= Number(b["y"]) + Number(b["h"]))
            {
               act = String(b["act"]);
               break;
            }
            i++;
         }
         if(act == "")
         {
            return;
         }
         var now:int = getTimer();
         var busy:Boolean = st["net"] == true;
         var body:Object = null;
         var url:String = "";
         var n:Number = 0;
         var s:String = "";
         var k:int = 0;
         var pwd:String = "";
         if(act == "fu")
         {
            stage.focus = st["tfU"];
            return;
         }
         if(act == "fp")
         {
            stage.focus = st["tfP"];
            return;
         }
         if(act == "back")
         {
            st["panel"] = "home";
            st["msg"] = "";
            st["dirty"] = true;
            return;
         }
         if(act == "input")
         {
            st["panel"] = "input";
            st["mode"] = "login";
            st["msg"] = "";
            st["dirty"] = true;
            return;
         }
         if(busy)
         {
            return;
         }
         if(act == "register")
         {
            if(String(st["user"]) == "" || String(st["pass"]) == "")
            {
               n = Number(st["dev"]) % 100000000;
               s = String(int(n));
               while(s.length < 8)
               {
                  s = "0" + s;
               }
               st["user"] = "cn" + s;
               pwd = "Pk";
               k = 0;
               while(k < 6)
               {
                  pwd += String(int(Math.random() * 10));
                  k++;
               }
               st["pass"] = pwd + "zq";
            }
            body = {"username":st["user"],"password":st["pass"],"device_id":st["dev"],"version":"1"};
            st["want"] = {"tag":"register","url":String(st["base"]) + "/sp-auth/register","body":JSON.stringify(body)};
            st["msg"] = "";
            st["dirty"] = true;
            return;
         }
         if(act == "submit")
         {
            if(String(st["user"]).length < 4 || String(st["pass"]).length < 8)
            {
               st["msg"] = "请先填写用户名和密码。";
               st["dirty"] = true;
               return;
            }
            if(String(st["mode"]) == "register")
            {
               body = {"username":st["user"],"password":st["pass"],"device_id":st["dev"],"version":"1"};
               st["want"] = {"tag":"register","url":String(st["base"]) + "/sp-auth/register","body":JSON.stringify(body)};
            }
            else
            {
               body = {"login_name":st["user"],"password":st["pass"],"device_id":st["dev"]};
               st["want"] = {"tag":"login","url":String(st["base"]) + "/sp-auth/login","body":JSON.stringify(body)};
            }
            st["msg"] = "";
            st["dirty"] = true;
            return;
         }
         if(act == "check")
         {
            if(String(st["token"]) != "")
            {
               body = {"token":st["token"],"device_id":st["dev"]};
               url = String(st["base"]) + "/sp-auth/bind-status";
               st["want"] = {"tag":"bind","url":url,"body":JSON.stringify(body)};
            }
            else
            {
               body = {"login_name":st["user"],"password":st["pass"],"device_id":st["dev"]};
               url = String(st["base"]) + "/sp-auth/login";
               st["want"] = {"tag":"login","url":url,"body":JSON.stringify(body)};
            }
            st["pollAt"] = 0;
            st["msg"] = "";
            st["dirty"] = true;
            return;
         }
         if(act == "resend")
         {
            if(String(st["token"]) == "")
            {
               st["msg"] = "请先在上一步获取验证码。";
               st["dirty"] = true;
               return;
            }
            if(now < int(st["resendAt"]))
            {
               st["msg"] = "操作太频繁，请稍后再试。";
               st["dirty"] = true;
               return;
            }
            body = {"token":st["token"],"device_id":st["dev"]};
            st["want"] = {"tag":"resend","url":String(st["base"]) + "/sp-auth/resend","body":JSON.stringify(body)};
            st["msg"] = "";
            st["dirty"] = true;
            return;
         }
      }
      
      // ===================================================================
      // 靶方法体 4/5：网络回包（原 testHeartbeat 是死代码）
      // 无参签名 ⇒ 安全作为 URLLoader 的 COMPLETE / IO_ERROR 监听器。
      // ===================================================================
      public function testHeartbeat() : void
      {
         var root:Object = Lib.current;
         var st:Object = root["sp6"];
         if(st == null)
         {
            return;
         }
         var ldr:URLLoader = st["loader"] as URLLoader;
         var tag:String = String(st["req"]);
         var stg:Object = st["stage"];
         st["net"] = false;
         st["loader"] = null;
         st["req"] = "";
         if(ldr == null)
         {
            return;
         }
         var txt:String = "";
         try
         {
            txt = String(ldr.data);
         }
         catch(e:Error)
         {
            txt = "";
         }
         var resp:Object = null;
         if(txt != "")
         {
            try
            {
               resp = JSON.parse(txt);
            }
            catch(e2:Error)
            {
               resp = null;
            }
         }
         var now:int = getTimer();
         if(resp == null)
         {
            st["msg"] = "网络异常，请重试";
            st["dirty"] = true;
            return;
         }
         var ok:Boolean = Boolean(resp["ok"]);
         var data:Object = resp["data"];
         var code:String = resp["code"] == null ? "" : String(resp["code"]);
         var msg:String = code == null ? "" : String(code);
         var expires:String = "";
         var exp:Number = 0;
         var ems:Number = 0;
         var ems2:Number = 0;
         var ui:Object = null;
         var hdl:Function = null;
         var tries:int = 0;
         var user:String = "";
         var pwd:String = "";
         var k:int = 0;
         var s:String = "";
         var n:Number = 0;
         // ---- C7 错误码 → 可读文案（唯一一处） ----
         if(code == "USERNAME_TAKEN")
         {
            msg = "该登录名已被使用，请换一个。";
         }
         else if(code == "USERNAME_INVALID")
         {
            msg = "登录名格式不合法（4-20 位字母/数字/下划线，且不能以数字开头）。";
         }
         else if(code == "PASSWORD_WEAK")
         {
            msg = "密码强度不足（8-64 位，需同时含大写字母、小写字母和数字）。";
         }
         else if(code == "DEVICE_TAKEN")
         {
            msg = "本机已经注册过账号，请用账号密码登录。";
         }
         else if(code == "RATE_LIMITED")
         {
            msg = "操作太频繁，请稍后再试。";
         }
         else if(code == "BAD_CREDENTIALS")
         {
            msg = "登录名或密码不正确。";
         }
         else if(code == "BIND_REQUIRED")
         {
            msg = "该账号尚未完成 QQ/KOOK 绑定。";
         }
         else if(code == "ACCOUNT_DISABLED")
         {
            msg = "该账号已被停用，请联系管理员。";
         }
         else if(code == "TOKEN_INVALID")
         {
            msg = "登录状态已失效，请重新登录。";
         }
         else if(code == "CODE_INVALID")
         {
            msg = "验证码不正确。";
         }
         else if(code == "CODE_EXPIRED")
         {
            msg = "验证码已过期，请在游戏里重新获取。";
         }
         else if(code == "CODE_USED")
         {
            msg = "验证码已被使用。";
         }
         else if(code == "CODE_LOCKED")
         {
            msg = "验证码尝试次数过多，已锁定，请重新获取。";
         }
         else if(code == "SERVICE_UNAVAILABLE")
         {
            msg = "服务暂时不可用，请稍后再试。";
         }
         else if(code != "")
         {
            msg = "请求失败（" + code + "）。";
         }
         else
         {
            msg = "";
         }
         // ---- 绑定成功 → 拆页并放行接缝回调 ----
         if(ok && (tag == "register" || tag == "login" || tag == "bind"))
         {
            if(tag == "register")
            {
               st["token"] = data == null ? "" : String(data["token"]);
               st["code"] = data == null ? "" : String(data["code"]);
               st["codeShown"] = "";
               expires = data == null ? "" : String(data["code_expires_at"]);
               st["panel"] = "code";
               st["pollGap"] = 3000;
               st["pollAt"] = now + 3000;
               st["msg"] = "";
               st["tries"] = 0;
               st["resendAt"] = now + 60000;
            }
            else if(tag == "login")
            {
               st["token"] = data == null ? "" : String(data["token"]);
               st["done"] = true;
            }
            else
            {
               if(data == null || data["bound"] != true)
               {
                  if(data != null)
                  {
                     if(data["code"] != null)
                     {
                        st["code"] = String(data["code"]);
                     }
                     expires = data["code_expires_at"] == null ? "" : String(data["code_expires_at"]);
                     if(expires != "")
                     {
                        exp = Date.parse(expires);
                        ems = new Date().getTime();
                        if(exp > 0)
                        {
                           st["codeAt"] = now + int(exp - ems);
                        }
                     }
                  }
                  st["pollAt"] = now + int(st["pollGap"]);
                  st["msg"] = "";
                  st["dirty"] = true;
                  return;
               }
               st["done"] = true;
            }
            if(tag == "register" || tag == "bind")
            {
               if(expires == "")
               {
                  expires = data == null ? "" : String(data["code_expires_at"]);
               }
               exp = expires == "" ? 0 : Date.parse(expires);
               ems2 = new Date().getTime();
               st["codeAt"] = exp > 0 ? now + int(exp - ems2) : now + 600000;
               st["codeLeft"] = int((int(st["codeAt"]) - now) / 1000);
            }
            if(st["done"] == true)
            {
               st["msg"] = "";
               ui = st["ui"];
               if(ui != null)
               {
                  try
                  {
                     stg.removeChild(ui);
                  }
                  catch(e3:Error)
                  {
                  }
               }
               st["ui"] = null;
               root.removeEventListener(Event.ENTER_FRAME,this.testLogin);
               hdl = st["handler"] as Function;
               if(hdl != null)
               {
                  hdl(String(st["dev"]));
               }
               return;
            }
            st["dirty"] = true;
            return;
         }
         // ---- 失败分支 ----
         if(tag == "login" && code == "BIND_REQUIRED")
         {
            st["panel"] = "code";
            st["codeShown"] = "";
            if(data != null && data["code"] != null)
            {
               st["code"] = String(data["code"]);
            }
            st["token"] = data != null && data["token"] != null ? String(data["token"]) : "";
            expires = data != null && data["code_expires_at"] != null ? String(data["code_expires_at"]) : "";
            exp = expires == "" ? 0 : Date.parse(expires);
            ems = new Date().getTime();
            st["codeAt"] = exp > 0 ? now + int(exp - ems) : now + 600000;
            st["codeLeft"] = int((int(st["codeAt"]) - now) / 1000);
            st["pollGap"] = String(st["token"]) != "" ? 3000 : 5000;
            st["pollAt"] = now + int(st["pollGap"]);
            st["msg"] = "";
            st["dirty"] = true;
            return;
         }
         if(tag == "register" && code == "USERNAME_TAKEN")
         {
            tries = int(st["tries"]) + 1;
            st["tries"] = tries;
            if(tries <= 2)
            {
               n = Number(st["dev"]) % 100000000;
               s = String(int(n));
               while(s.length < 8)
               {
                  s = "0" + s;
               }
               user = "cn" + s + String(int(Math.random() * 1000));
               pwd = "Pk";
               k = 0;
               while(k < 6)
               {
                  pwd += String(int(Math.random() * 10));
                  k++;
               }
               st["user"] = user;
               st["pass"] = pwd + "zq";
               st["want"] = {"tag":"register","url":String(st["base"]) + "/sp-auth/register","body":JSON.stringify({"username":user,"password":String(st["pass"]),"device_id":st["dev"],"version":"1"})};
               st["dirty"] = true;
               return;
            }
         }
         if(tag == "register" && code == "DEVICE_TAKEN")
         {
            st["panel"] = "input";
            st["mode"] = "login";
            st["user"] = "";
            st["pass"] = "";
         }
         if(tag == "resend" && code == "RATE_LIMITED")
         {
            st["resendAt"] = now + 60000;
         }
         if(tag == "resend" && ok && data != null)
         {
            st["code"] = String(data["code"]);
            st["codeShown"] = "";
            expires = String(data["code_expires_at"]);
            exp = Date.parse(expires);
            ems = new Date().getTime();
            st["codeAt"] = exp > 0 ? now + int(exp - ems) : now + 600000;
            st["codeLeft"] = int((int(st["codeAt"]) - now) / 1000);
            st["resendAt"] = now + 60000;
            st["pollAt"] = now + int(st["pollGap"]);
            msg = "";
         }
         if(tag == "bind" && String(st["token"]) != "")
         {
            st["pollAt"] = now + int(st["pollGap"]);
         }
         st["msg"] = msg;
         st["dirty"] = true;
      }
      
      // ===================================================================
      // 靶方法体 5/5：拆页清理（框架钩子 dispose）
      // ===================================================================
      public function dispose() : void
      {
         var root:Object = Lib.current;
         var st:Object = root["sp6"];
         if(st == null)
         {
            return;
         }
         var ui:Object = st["ui"];
         var stage:Object = st["stage"];
         if(ui != null && stage != null)
         {
            try
            {
               stage.removeChild(ui);
            }
            catch(e:Error)
            {
            }
         }
         st["ui"] = null;
         root.removeEventListener(Event.ENTER_FRAME,this.testLogin);
         if(stage != null)
         {
            stage.removeEventListener(MouseEvent.MOUSE_DOWN,this.testLoginReport);
            if(stage.focus != null)
            {
               stage.focus = null;
            }
         }
         root["sp6"] = null;
      }
   }
}
