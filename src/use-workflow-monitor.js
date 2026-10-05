import {useCallback,useEffect,useRef,useState} from 'react'
import {loadWorkflowTelemetry} from './workflow-monitor-load'

export function useWorkflowMonitor({client,organizationId,userId,workflowId,days}) {
  const [snapshot,setSnapshot]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0)
  const sequence=useRef(0)
  const key=[organizationId,userId,workflowId||'',days].join(':')
  useEffect(()=>{
    const request=++sequence.current,controller=new AbortController()
    setLoading(true);setError('');setSnapshot(null)
    if(!organizationId||!userId){setLoading(false);return ()=>controller.abort()}
    loadWorkflowTelemetry({client,organizationId,workflowId,days,signal:controller.signal}).then(data=>{
      if(request!==sequence.current||controller.signal.aborted)return
      setSnapshot({key,...data})
      if(data.coverage.runsUnavailable)setError('Workflow history could not be loaded. Refresh to try again.')
    }).catch(()=>{if(request===sequence.current&&!controller.signal.aborted)setError('Workflow activity could not be loaded. Refresh to try again.')}).finally(()=>{if(request===sequence.current&&!controller.signal.aborted)setLoading(false)})
    return ()=>{controller.abort();sequence.current++}
  },[client,organizationId,userId,workflowId,days,revision])
  const refresh=useCallback(()=>setRevision(v=>v+1),[])
  return {...(snapshot?.key===key?snapshot:{}),loading:loading||!!snapshot&&snapshot.key!==key,error,refresh}
}
