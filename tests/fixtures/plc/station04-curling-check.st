PROGRAM Station04_CurlingCheck
(* Station 4 - curling check (replaces Logic_PLC_Station04).
   PLC mode: a real PLC owns the outputs - write nothing, restart at step 0. *)
VAR_EXTERNAL
  RV_SimulationMode : BOOL;               (* system *)
  SIM_AutoRelease : BOOL;                 (* cycle release *)
  SIM_Parked_Station04 : BOOL;            (* station idle *)
  FG_TS_Index04_B_Detect : BOOL;          (* pallet at 4 *)
  FG_TS_Index05_B_Detect : BOOL;          (* pallet at 5 *)
  FG_TS_Index04_B_Exit : BOOL;            (* pallet left 4 *)
  FG_TS_Index04_Y_Stopper_WorkPos : BOOL; (* open stopper *)
  FG04_Y_AxisZ_HomePos : BOOL;            (* probe up *)
  FG04_Y_AxisZ_WorkPos : BOOL;            (* probe down *)
  FG04_Y_AxisZ_InHome : BOOL;             (* probe is up *)
  FG04_Y_AxisZ_InWork : BOOL;             (* probe is down *)
END_VAR
VAR
  Step : INT;
  tMeasure : TON;
  rExit : R_TRIG;
  bMeasuring : BOOL;
END_VAR

  (* Function blocks run every scan so edges and timers stay consistent. *)
  bMeasuring := RV_SimulationMode AND (Step = 30);
  tMeasure(IN := bMeasuring, PT := T#1s);
  rExit(CLK := FG_TS_Index04_B_Exit);

  IF NOT RV_SimulationMode THEN
    Step := 0;  (* PLC mode: assign nothing *)
  ELSE
    CASE Step OF
      0: (* park, wait for the next pallet *)
        SIM_Parked_Station04 := TRUE;
        Step := 10;

      10: (* release, pallet at 4, station 5 free *)
        IF SIM_AutoRelease AND FG_TS_Index04_B_Detect AND NOT FG_TS_Index05_B_Detect THEN
          SIM_Parked_Station04 := FALSE;
          FG04_Y_AxisZ_HomePos := FALSE;
          FG04_Y_AxisZ_WorkPos := TRUE;
          Step := 20;
        END_IF;

      20: (* probe down *)
        IF FG04_Y_AxisZ_InWork THEN
          Step := 30;
        END_IF;

      30: (* measure 1 s *)
        IF tMeasure.Q THEN
          FG04_Y_AxisZ_WorkPos := FALSE;
          FG04_Y_AxisZ_HomePos := TRUE;
          Step := 40;
        END_IF;

      40: (* probe up, open the stopper *)
        IF FG04_Y_AxisZ_InHome THEN
          FG_TS_Index04_Y_Stopper_WorkPos := TRUE;
          Step := 50;
        END_IF;

      50: (* one pallet: close on the exit edge *)
        IF rExit.Q THEN
          FG_TS_Index04_Y_Stopper_WorkPos := FALSE;
          Step := 60;
        END_IF;

      60: (* pallet arrived at station 5 *)
        IF FG_TS_Index05_B_Detect THEN
          Step := 0;
        END_IF;
    ELSE
      Step := 0;
    END_CASE;
  END_IF;
END_PROGRAM
